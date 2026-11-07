import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
const Wbt = require('../lib/wbt/index.js');
const { daemonManager } = require('../lib/wbt/index.js');
const { pgliteInstances } = require('../lib/wbt/packages/pglite.js');

// Minimal valid WASM binary that exits cleanly with 0 via _start:
// (module (func (export "_start")))
const MINIMAL_WASM_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: 1 func () -> ()
    0x03, 0x02, 0x01, 0x00, // func section: 1 func of type 0
    0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00, // export "_start"
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b  // code section: empty body
]);

// Minimal WASM binary that exports `__eval() -> f64 (42.0)` for testing `asrun`
// (module (func (export "__eval") (result f64) f64.const 42))
const EVAL_42_WASM_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7c, // () -> f64
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x0a, 0x01, 0x06, 0x5f, 0x5f, 0x65, 0x76, 0x61, 0x6c, 0x00, 0x00, // export "__eval"
    0x0a, 0x0d, 0x01, 0x0b, 0x00, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x45, 0x40, 0x0b // f64.const 42.0
]);

/**
 * Standard CLI/Emscripten mock for sqlite3 so tests exercise the pure generic runtime + ReplCommand extension.
 */
function createMockSqlJs() {
    const { formatTable, formatPipeList, formatCsv } = require('../lib/wbt/utils.js');
    return {
        async main(args, io) {
            let mode = 'list';
            let dbPath = ':memory:';
            let sql = null;
            const positional = [];

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-table' || a === '--table' || a === '-box') mode = 'table';
                else if (a === '-csv' || a === '--csv') mode = 'csv';
                else if (a === '-cmd' && i + 1 < args.length) sql = args[++i];
                else if (!a.startsWith('-')) positional.push(a);
            }

            if (positional.length === 1) {
                if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|\.)\b/i.test(positional[0])) {
                    sql = positional[0];
                } else {
                    dbPath = positional[0];
                }
            } else if (positional.length >= 2) {
                dbPath = positional[0];
                sql = positional.slice(1).join(' ');
            }
            if (!sql && io.stdin && io.stdin.trim()) {
                sql = io.stdin.trim();
            }
            if (!sql) return 0;

            let state = { _tables: {} };
            if (dbPath !== ':memory:') {
                const existing = io.readFile(dbPath);
                if (existing) {
                    try { state = JSON.parse(existing); } catch { /* ignore */ }
                }
            }

            for (const rawStmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
                if (rawStmt === '.tables') {
                    io.stdout(Object.keys(state._tables).sort().join('  '));
                    continue;
                }
                const createMatch = rawStmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.+)\)/i);
                if (createMatch) {
                    const tbl = createMatch[1];
                    const cols = createMatch[2].split(',').map(c => c.trim().split(/\s+/)[0]);
                    state._tables[tbl] = { columns: cols, rows: [] };
                    continue;
                }
                const insertMatch = rawStmt.match(/^INSERT\s+INTO\s+(\w+)(?:\s*\(([^)]+)\))?\s+VALUES\s*\((.+)\)/i);
                if (insertMatch) {
                    const tbl = insertMatch[1];
                    const vals = insertMatch[3].split(',').map(v => {
                        const s = v.trim().replace(/^['"]|['"]$/g, '');
                        const n = Number(s);
                        return Number.isNaN(n) ? s : n;
                    });
                    state._tables[tbl].rows.push(vals);
                    continue;
                }
                const selectTableMatch = rawStmt.match(/^SELECT\s+(.+)\s+FROM\s+(\w+)/i);
                if (selectTableMatch) {
                    const tbl = state._tables[selectTableMatch[2]];
                    if (tbl) {
                        const lines = mode === 'table'
                            ? formatTable(tbl.columns, tbl.rows, { showRowCount: false })
                            : mode === 'csv'
                                ? formatCsv(tbl.columns, tbl.rows, true)
                                : formatPipeList(tbl.columns, tbl.rows, false);
                        lines.forEach(l => io.stdout(l));
                    }
                    continue;
                }
                const selectExprMatch = rawStmt.match(/^SELECT\s+(.+?)(?:\s+AS\s+(\w+))?$/i);
                if (selectExprMatch) {
                    const val = Function(`return (${selectExprMatch[1]})`)();
                    io.stdout(String(val));
                }
            }

            if (dbPath !== ':memory:') {
                io.writeFile(dbPath, JSON.stringify(state));
            }
            return 0;
        }
    };
}

/**
 * In-memory mock implementation of @electric-sql/pglite for deterministic tests.
 */
function createMockPglite() {
    class MockPGlite {
        constructor(dataDir) {
            this.dataDir = dataDir || 'memory://';
            this._tables = {};
            this.waitReady = Promise.resolve();
        }

        static async create(dataDir) {
            return new MockPGlite(dataDir);
        }

        async exec(sql) {
            const results = [];
            const statements = sql
                .split(';')
                .map(s => s.trim())
                .filter(Boolean);

            for (const stmt of statements) {
                if (/FROM\s+pg_catalog\.pg_tables/i.test(stmt)) {
                    const rows = Object.keys(this._tables).map(t => ({
                        schema: 'public',
                        name: t,
                        owner: 'postgres'
                    }));
                    results.push({
                        fields: [{ name: 'schema' }, { name: 'name' }, { name: 'owner' }],
                        rows
                    });
                    continue;
                }

                const createMatch = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.+)\)/i);
                if (createMatch) {
                    const tbl = createMatch[1];
                    const cols = createMatch[2].split(',').map(c => c.trim().split(/\s+/)[0]);
                    this._tables[tbl] = { columns: cols, rows: [] };
                    results.push({ fields: [], rows: [], affectedRows: 0 });
                    continue;
                }

                const insertMatch = stmt.match(/^INSERT\s+INTO\s+(\w+)(?:\s*\(([^)]+)\))?\s+VALUES\s*\((.+)\)/i);
                if (insertMatch) {
                    const tbl = insertMatch[1];
                    if (!this._tables[tbl]) throw new Error(`relation "${tbl}" does not exist`);
                    const vals = insertMatch[3].split(',').map(v => {
                        const s = v.trim();
                        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
                            return s.slice(1, -1);
                        }
                        const n = Number(s);
                        return Number.isNaN(n) ? s : n;
                    });
                    const rowObj = {};
                    this._tables[tbl].columns.forEach((c, idx) => { rowObj[c] = vals[idx]; });
                    this._tables[tbl].rows.push(rowObj);
                    results.push({ fields: [], rows: [], affectedRows: 1 });
                    continue;
                }

                const selectTableMatch = stmt.match(/^SELECT\s+(.+)\s+FROM\s+(\w+)/i);
                if (selectTableMatch) {
                    const tbl = selectTableMatch[2];
                    if (!this._tables[tbl]) throw new Error(`relation "${tbl}" does not exist`);
                    const tableObj = this._tables[tbl];
                    results.push({
                        fields: tableObj.columns.map(c => ({ name: c })),
                        rows: tableObj.rows
                    });
                    continue;
                }

                const selectExprMatch = stmt.match(/^SELECT\s+(.+)/i);
                if (selectExprMatch) {
                    const exprs = selectExprMatch[1].split(',').map(e => e.trim());
                    const fields = [];
                    const rowObj = {};
                    for (const expr of exprs) {
                        const asMatch = expr.match(/^(.+?)\s+AS\s+(\w+)$/i);
                        const rawExpr = asMatch ? asMatch[1].trim() : expr;
                        const colName = asMatch ? asMatch[2] : '?column?';
                        fields.push({ name: colName });
                        if ((rawExpr.startsWith("'") && rawExpr.endsWith("'")) || (rawExpr.startsWith('"') && rawExpr.endsWith('"'))) {
                            rowObj[colName] = rawExpr.slice(1, -1);
                        } else if (/^[\d\s+\-*/%()]+$/.test(rawExpr)) {
                            rowObj[colName] = Function(`return (${rawExpr})`)();
                        } else {
                            rowObj[colName] = rawExpr;
                        }
                    }
                    results.push({ fields, rows: [rowObj] });
                    continue;
                }

                throw new Error(`syntax error at or near "${stmt}"`);
            }
            return results;
        }

        async close() {}
    }

    return { PGlite: MockPGlite };
}

/**
 * Mock AssemblyScript CLI (`assemblyscript/asc`).
 */
function createMockAsc() {
    return {
        ready: Promise.resolve(),
        async main(args, options) {
            let inputFile = null;
            let outFile = null;
            let textFile = null;
            let evalCode = null;
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if ((a === '-o' || a === '--outFile') && i + 1 < args.length) {
                    outFile = args[++i];
                } else if ((a === '-t' || a === '--textFile') && i + 1 < args.length) {
                    textFile = args[++i];
                } else if ((a === '-e' || a === '--eval') && i + 1 < args.length) {
                    evalCode = args[++i];
                } else if (!a.startsWith('-')) {
                    inputFile = a;
                }
            }
            if (evalCode !== null) {
                options.stdout(String(Function(`return (${evalCode})`)()));
                return { error: null };
            }
            if (!inputFile) {
                options.stderr.write('ERROR: No input file specified\n');
                return { error: new Error('No input file specified') };
            }
            const src = options.readFile(inputFile, '.');
            if (src == null) {
                options.stderr.write(`ERROR: File not found: ${inputFile}\n`);
                return { error: new Error(`File not found: ${inputFile}`) };
            }
            if (src.includes('SYNTAX_ERROR')) {
                options.stderr.write(`ERROR TS1005: ';' expected in ${inputFile}\n`);
                return { error: new Error('Compilation failed') };
            }
            if (outFile) {
                const bytesToWrite = src.includes('__eval') ? EVAL_42_WASM_BYTES : MINIMAL_WASM_BYTES;
                options.writeFile(outFile, bytesToWrite, '.');
            }
            if (textFile) {
                options.writeFile(textFile, '(module\n  (func (export "_start"))\n)\n', '.');
            }
            return { error: null };
        }
    };
}

/**
 * Mock QuickJS module using standard CLI main(args, io).
 */
function createMockQuickJs() {
    return {
        async main(args, io) {
            let code = io.stdin;
            for (let i = 0; i < args.length; i++) {
                if ((args[i] === '-e' || args[i] === '--eval') && i + 1 < args.length) code = args[++i];
                else if (!args[i].startsWith('-')) code = io.readFile(args[i]);
            }
            if (code) io.stdout(String(Function(`return (${code})`)()));
            return 0;
        }
    };
}

/**
 * Mock Lua module using standard CLI main(args, io).
 */
function createMockLua() {
    return {
        async main(args, io) {
            let code = io.stdin;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-e' && i + 1 < args.length) code = args[++i];
                else if (!args[i].startsWith('-')) code = io.readFile(args[i]);
            }
            if (code) {
                const retMatch = code.match(/^return\s+(.+)$/);
                if (retMatch) io.stdout(String(Function(`return (${retMatch[1]})`)()));
            }
            return 0;
        }
    };
}

/**
 * Mock jq module using standard CLI main(args, io).
 */
function createMockJq() {
    return {
        async main(args, io) {
            const positional = args.filter(a => !a.startsWith('-'));
            const filter = positional.shift() || '.';
            const input = positional.length > 0 ? io.readFile(positional[0]) : io.stdin;
            const data = JSON.parse(input);
            const parts = filter.replace(/^\./, '').split('.').filter(Boolean);
            let cur = data;
            for (const p of parts) {
                cur = cur ? cur[p] : undefined;
            }
            io.stdout(typeof cur === 'string' && args.includes('-r') ? cur : JSON.stringify(cur));
            return 0;
        }
    };
}

/**
 * Mock Python3 module using standard CLI main(args, io).
 */
function createMockPyodide() {
    return {
        async main(args, io) {
            let code = null;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-c' && i + 1 < args.length) code = args[++i];
                else if (!args[i].startsWith('-')) code = io.readFile(args[i]);
            }
            if (!code) code = io.stdin;
            const printMatch = code && code.match(/print\(['"](.+?)['"]\)/);
            if (printMatch) io.stdout(printMatch[1]);
            else if (code && /^[\d\s+\-*/%()]+$/.test(code.trim())) io.stdout(String(Function(`return (${code})`)()));
            return 0;
        }
    };
}

/**
 * Mock DuckDB module using standard CLI main(args, io).
 */
function createMockDuckDb() {
    return {
        async main(args, io) {
            let sql = io.stdin;
            for (let i = 0; i < args.length; i++) {
                if ((args[i] === '-c' || args[i] === '-s') && i + 1 < args.length) sql = args[++i];
            }
            if (/SELECT\s+100\s+AS\s+total/i.test(sql)) {
                io.stdout('100');
            }
            return 0;
        }
    };
}

/**
 * Mock Graphviz module using standard CLI main(args, io).
 */
function createMockGraphviz() {
    return {
        async main(args, io) {
            let outFile = null;
            let inFile = null;
            for (let i = 0; i < args.length; i++) {
                if (args[i] === '-o' && i + 1 < args.length) outFile = args[++i];
                else if (!args[i].startsWith('-')) inFile = args[i];
            }
            const dotSource = inFile ? io.readFile(inFile) : io.stdin;
            const svg = `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${(dotSource || '').trim()} --></svg>`;
            if (outFile) io.writeFile(outFile, svg);
            else io.stdout(svg);
            return 0;
        }
    };
}

/**
 * Mock FFmpeg virtual-FS class (instantiated by generic runtime's class/virtual-FS support).
 */
function createMockFfmpeg() {
    return class MockFFmpeg {
        constructor() {
            this.loaded = false;
            this._files = new Map();
            this._listeners = [];
        }
        on(evt, cb) {
            if (evt === 'log') this._listeners.push(cb);
        }
        async load() {
            this.loaded = true;
        }
        async writeFile(name, bytes) {
            this._files.set(name, bytes);
        }
        async exec(args) {
            const outName = args[args.length - 1];
            for (const cb of this._listeners) {
                cb({ message: `Transcoding to ${outName} complete` });
            }
            this._files.set(outName, new TextEncoder().encode('WEBVTT-TRANSCODED'));
            return 0;
        }
        async readFile(name) {
            return this._files.get(name) || null;
        }
    };
}

/**
 * Mock Emscripten modularized CLI package (no custom adapter — tests generic runtime!).
 */
function createMockEmscriptenCowsay() {
    return async function EmscriptenModule(opts) {
        return {
            FS: {
                _files: {},
                writeFile(p, d) { this._files[p] = d; },
                readFile(p) {
                    if (!(p in this._files)) throw new Error('ENOENT');
                    return this._files[p];
                }
            },
            callMain(args) {
                opts.print(`< ${args.join(' ') || 'moo'} >`);
                return 0;
            }
        };
    };
}

function createTestWbt() {
    return Wbt.configure({
        moduleLoader: async (pkgName) => {
            if (pkgName === 'sql.js' || pkgName === 'sqlite3') return createMockSqlJs();
            if (pkgName === '@electric-sql/pglite' || pkgName === 'pglite') return createMockPglite();
            if (pkgName === 'assemblyscript/asc' || pkgName === 'assemblyscript') return createMockAsc();
            if (pkgName === 'quickjs-emscripten' || pkgName === 'quickjs') return createMockQuickJs();
            if (pkgName === 'wasmoon' || pkgName === 'lua') return createMockLua();
            if (pkgName === 'jq-web' || pkgName === 'jq') return createMockJq();
            if (pkgName === 'pyodide' || pkgName === 'python3') return createMockPyodide();
            if (pkgName === '@duckdb/duckdb-wasm' || pkgName === 'duckdb') return createMockDuckDb();
            if (pkgName === '@hpcc-js/wasm-graphviz' || pkgName === 'graphviz') return createMockGraphviz();
            if (pkgName === '@ffmpeg/ffmpeg' || pkgName === 'ffmpeg') return createMockFfmpeg();
            if (pkgName === 'cowsay-wasm') return createMockEmscriptenCowsay();
            return null;
        },
        fetch: async (url) => {
            if (url === 'https://example.com/hello.wasm') {
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => MINIMAL_WASM_BYTES.buffer
                };
            }
            if (url === 'https://example.com/registry.json') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        custompkg: {
                            name: 'custompkg',
                            bin: 'custompkg',
                            version: '2.0.0',
                            description: 'Remote registry test package',
                            cdnUrl: 'https://esm.sh/custompkg@2.0.0',
                            type: 'builtin-adapter',
                            adapter: 'quickjs'
                        }
                    })
                };
            }
            return { ok: false, status: 404 };
        },
        sources: ['https://example.com/registry.json']
    });
}

// ============================================================================
// Tests
// ============================================================================

describe('WBT optional package behavior', () => {
    it('is NOT included in a default Shell instance unless registered', async () => {
        const shell = await createShell();
        const { errors, exitCode } = await run(shell, 'wbt list');
        expect(exitCode).toBe(1);
        expect(errors.join(' ')).toMatch(/Command not found/i);
    });

    it('can be registered into a Shell instance via shell.context.setCommand(Wbt)', async () => {
        const shell = await createShell();
        shell.context.setCommand(createTestWbt());
        const { output, exitCode } = await run(shell, 'wbt --version');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('wbt 1.1.0');
    });
});

describe('WBT CLI subcommands (list, search, show, install, remove, update)', () => {
    let shell;

    beforeEach(async () => {
        await daemonManager.stopAll();
        pgliteInstances.clear();
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
    });

    it('shows help when run with no arguments or --help', async () => {
        const { output, exitCode } = await run(shell, 'wbt');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('Web Binary Tool');
        expect(text).toContain('pglite');
        expect(text).toContain('sqlite3');
        expect(text).toContain('assemblyscript');
        expect(text).toContain('jq');
        expect(text).toContain('python3');
        expect(text).toContain('duckdb');
        expect(text).toContain('graphviz');
        expect(text).toContain('ffmpeg');
    });

    it('lists available packages with `wbt list` and installed packages with `wbt list --installed`', async () => {
        const allRes = await run(shell, 'wbt list');
        expect(allRes.exitCode).toBe(0);
        expect(allRes.output.join('\n')).toContain('pglite/wasm');
        expect(allRes.output.join('\n')).toContain('sqlite3/wasm');
        expect(allRes.output.join('\n')).toContain('assemblyscript/wasm');

        const emptyInstalled = await run(shell, 'wbt list --installed');
        expect(emptyInstalled.exitCode).toBe(0);
        expect(emptyInstalled.output).toEqual(['Listing...']);

        await run(shell, 'wbt install sqlite3');
        const afterInstall = await run(shell, 'wbt list --installed');
        expect(afterInstall.output.join('\n')).toContain('sqlite3/wasm');
        expect(afterInstall.output.join('\n')).toContain('[installed]');
    });

    it('searches packages by keyword with `wbt search`', async () => {
        const { output, exitCode } = await run(shell, 'wbt search postgres');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('pglite/wasm');
        expect(output.join('\n')).not.toContain('lua/wasm');
    });

    it('shows detailed package metadata with `wbt show`', async () => {
        const { output, exitCode } = await run(shell, 'wbt show pglite');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('Package: pglite');
        expect(text).toContain('State: not installed');
        expect(text).toContain('Binary: pglite');

        await run(shell, 'wbt install pglite');
        const afterShow = await run(shell, 'wbt show pglite');
        expect(afterShow.output.join('\n')).toContain('State: installed');
    });

    it('returns an error when installing an unknown package', async () => {
        const { errors, exitCode } = await run(shell, 'wbt install nonexistent-wasm-pkg');
        expect(exitCode).toBe(100);
        expect(errors.join(' ')).toContain('Unable to locate package nonexistent-wasm-pkg');
    });

    it('removes an installed package and unregisters its binary from /bin', async () => {
        await run(shell, 'wbt install sqlite3');
        const check1 = await run(shell, 'which sqlite3');
        expect(check1.output.join('')).toContain('/bin/sqlite3');

        const rmRes = await run(shell, 'wbt remove sqlite3');
        expect(rmRes.exitCode).toBe(0);
        expect(rmRes.output.join('\n')).toContain('Removing sqlite3');

        const check2 = await run(shell, 'sqlite3 --version');
        expect(check2.exitCode).toBe(1);
        expect(check2.errors.join(' ')).toMatch(/Command not found/i);
    });

    it('updates remote sources with `wbt update`', async () => {
        const { output, exitCode } = await run(shell, 'wbt update');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('Reading package lists... Done');

        const showCustom = await run(shell, 'wbt show custompkg');
        expect(showCustom.exitCode).toBe(0);
        expect(showCustom.output.join('\n')).toContain('Remote registry test package');
    });

    it('restores installed commands from /var/lib/wbt/installed.json via Wbt.restoreInstalled', async () => {
        await run(shell, 'wbt install sqlite3');
        const rawFs = shell.context.fs.getRaw();
        const rawPerms = shell.context.fs.getRawPermissions();

        const savedInstalledJson = rawFs.var.lib.wbt['installed.json'];
        const shell2 = await createShell({
            filesystem: {
                var: { lib: { wbt: { 'installed.json': savedInstalledJson } } }
            },
            permissions: rawPerms
        });
        const TestWbt = createTestWbt();
        shell2.context.setCommand(TestWbt);
        TestWbt.restoreInstalled(shell2);

        const { output, exitCode } = await run(shell2, 'sqlite3 --version');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('1.13.0');
    });
});

describe('WBT SQLite3 WASM package (`sqlite3` / `sqlite`)', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install sqlite');
    });

    it('executes one-shot SQL queries and formats output', async () => {
        const { output, exitCode } = await run(shell, 'sqlite3 "SELECT 40 + 2 AS answer"');
        expect(exitCode).toBe(0);
        expect(output).toContain('42');
    });

    it('persists SQLite database files in the brsh filesystem across invocations', async () => {
        const res1 = await run(
            shell,
            'sqlite3 /home/app.db "CREATE TABLE users (id INT, name TEXT); INSERT INTO users VALUES (1, \'Ada\'); INSERT INTO users VALUES (2, \'Grace\');"'
        );
        expect(res1.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/app.db')).toBe(true);

        const res2 = await run(shell, 'sqlite3 -table /home/app.db "SELECT * FROM users"');
        expect(res2.exitCode).toBe(0);
        const tableOut = res2.output.join('\n');
        expect(tableOut).toContain('Ada');
        expect(tableOut).toContain('Grace');
        expect(tableOut).toContain('id');
        expect(tableOut).toContain('name');
    });

    it('supports piped SQL via stdin and dot-commands (.tables)', async () => {
        await run(shell, 'sqlite3 /home/test.db "CREATE TABLE items (id INT, title TEXT); INSERT INTO items VALUES (10, \'Book\');"');
        const piped = await run(shell, 'echo "SELECT * FROM items;" | sqlite3 -csv /home/test.db');
        expect(piped.exitCode).toBe(0);
        expect(piped.output.join('\n')).toContain('id,title');
        expect(piped.output.join('\n')).toContain('10,Book');

        const tablesRes = await run(shell, 'sqlite3 /home/test.db ".tables"');
        expect(tablesRes.exitCode).toBe(0);
        expect(tablesRes.output.join('\n')).toContain('items');
    });
});

describe('WBT PGlite WASM package (`pglite`, `psql`, `pg_ctl` & background server daemon)', () => {
    let shell;

    beforeEach(async () => {
        await daemonManager.stopAll();
        pgliteInstances.clear();
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install pglite');
    });

    it('runs one-shot SQL queries with `pglite -c` or positional SQL', async () => {
        const { output, exitCode } = await run(shell, 'pglite -c "SELECT 7 * 6 AS product"');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('product');
        expect(text).toContain('42');
        expect(text).toContain('(1 row)');
    });

    it('persists database state across commands when a data directory is given and supports `psql` alias', async () => {
        const initRes = await run(
            shell,
            'pglite -d /home/pgdata -c "CREATE TABLE projects (id INT, title TEXT); INSERT INTO projects VALUES (1, \'Brsh\');"'
        );
        expect(initRes.exitCode).toBe(0);

        const queryRes = await run(
            shell,
            'psql -d /home/pgdata -c "SELECT * FROM projects"'
        );
        expect(queryRes.exitCode).toBe(0);
        expect(queryRes.output.join('\n')).toContain('Brsh');

        const dtRes = await run(shell, 'psql -d /home/pgdata -c "\\dt"');
        expect(dtRes.exitCode).toBe(0);
        expect(dtRes.output.join('\n')).toContain('projects');
    });

    it('starts a background PGlite server daemon (`pglite serve` / `pg_ctl start`), serves HTTP SQL via `curl`, and stops cleanly', async () => {
        const startRes = await run(shell, 'pg_ctl start -D /home/pgdaemon -p 5432');
        expect(startRes.exitCode).toBe(0);
        expect(startRes.output.join('\n')).toContain('server started');

        // Verify `wbt services` lists the running daemon
        const svcRes = await run(shell, 'wbt services');
        expect(svcRes.exitCode).toBe(0);
        expect(svcRes.output.join('\n')).toContain('pglite');
        expect(svcRes.output.join('\n')).toContain('5432');

        // Query the live daemon over HTTP via `curl`!
        const curlStatus = await run(shell, 'curl -s http://localhost:5432/status');
        expect(curlStatus.exitCode).toBe(0);
        expect(curlStatus.output.join('\n')).toContain('"status":"ready"');

        // Create table & insert via HTTP POST to the daemon
        const curlCreate = await run(
            shell,
            'curl -s -X POST -d "CREATE TABLE tasks (id INT, name TEXT); INSERT INTO tasks VALUES (1, \'DaemonTask\');" http://localhost:5432/query'
        );
        expect(curlCreate.exitCode).toBe(0);

        // Query via `psql` client (auto-connects to the running daemon on port 5432!)
        const psqlRes = await run(shell, 'psql -p 5432 -c "SELECT * FROM tasks"');
        expect(psqlRes.exitCode).toBe(0);
        expect(psqlRes.output.join('\n')).toContain('DaemonTask');

        // Stop the daemon with `pg_ctl stop`
        const stopRes = await run(shell, 'pg_ctl stop -p 5432');
        expect(stopRes.exitCode).toBe(0);
        expect(stopRes.output.join('\n')).toContain('server stopped');

        const statusAfter = await run(shell, 'pg_ctl status -p 5432');
        expect(statusAfter.exitCode).toBe(3);
    });
});

describe('WBT AssemblyScript compiler (`asc`) and JIT/AOT runtime (`asrun` / `asnode`)', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'hello.ts': 'export function _start(): void {}',
                    'broken.ts': 'SYNTAX_ERROR'
                }
            }
        });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install assemblyscript');
    });

    it('compiles AssemblyScript source files in the brsh filesystem to executable .wasm binaries', async () => {
        const compileRes = await run(shell, 'asc /home/hello.ts -o /home/hello.wasm -t /home/hello.wat');
        expect(compileRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/hello.wasm')).toBe(true);
        expect(shell.context.fs.exists('/home/hello.wat')).toBe(true);
        expect(shell.context.fs.isExecutable('/home/hello.wasm')).toBe(true);

        // Execute the compiled .wasm binary directly in brsh!
        const execRes = await run(shell, '/home/hello.wasm');
        expect(execRes.exitCode).toBe(0);
    });

    it('runs AssemblyScript `.ts` files and `-e` expressions directly via `asrun` / `asnode`', async () => {
        const evalRes = await run(shell, 'asrun -e "21 * 2"');
        expect(evalRes.exitCode).toBe(0);
        expect(evalRes.output).toContain('42');

        const fileRes = await run(shell, 'asnode /home/hello.ts');
        expect(fileRes.exitCode).toBe(0);
    });

    it('reports compilation errors on invalid AssemblyScript source', async () => {
        const { errors, exitCode } = await run(shell, 'asc /home/broken.ts -o /home/broken.wasm');
        expect(exitCode).toBe(1);
        expect(errors.join('\n')).toContain('TS1005');
    });
});

describe('WBT Curated WASM Tools (`jq`, `python3`, `duckdb`, `dot`, `ffmpeg`) & Generic Runtime', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'data.json': '{"user":{"name":"Ada","role":"admin"}}',
                    'hello.py': 'print("Hello from Pyodide!")',
                    'graph.dot': 'digraph G { A -> B; }',
                    'input.mp4': 'RAW_MEDIA_BYTES'
                }
            }
        });
        shell.context.setCommand(createTestWbt());
    });

    it('processes JSON files and piped JSON with `jq`', async () => {
        await run(shell, 'wbt install jq');
        const res = await run(shell, 'cat /home/data.json | jq -r ".user.name"');
        expect(res.exitCode).toBe(0);
        expect(res.output).toContain('Ada');
    });

    it('runs Python 3 scripts and `-c` expressions with `python3` / `python`', async () => {
        await run(shell, 'wbt install python3');
        const scriptRes = await run(shell, 'python3 /home/hello.py');
        expect(scriptRes.exitCode).toBe(0);
        expect(scriptRes.output).toContain('Hello from Pyodide!');

        const evalRes = await run(shell, 'python -c "6 * 7"');
        expect(evalRes.exitCode).toBe(0);
        expect(evalRes.output).toContain('42');
    });

    it('runs analytical SQL queries with `duckdb`', async () => {
        await run(shell, 'wbt install duckdb');
        const res = await run(shell, 'duckdb -c "SELECT 100 AS total"');
        expect(res.exitCode).toBe(0);
        expect(res.output.join('\n')).toContain('100');
    });

    it('compiles Graphviz DOT files to SVG with `dot` (`graphviz` package)', async () => {
        await run(shell, 'wbt install graphviz');
        const res = await run(shell, 'dot -Tsvg /home/graph.dot -o /home/graph.svg');
        expect(res.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/graph.svg')).toBe(true);
        expect(shell.context.fs.getFileByPath('/home/graph.svg')).toContain('<svg');
    });

    it('transcodes media files in the brsh filesystem with `ffmpeg`', async () => {
        await run(shell, 'wbt install ffmpeg');
        const res = await run(shell, 'ffmpeg -i /home/input.mp4 /home/output.webm');
        expect(res.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/output.webm')).toBe(true);
    });

    it('wraps arbitrary Emscripten / NPM packages at runtime without a custom adapter (`wbt install npm:<pkg>`)', async () => {
        const installRes = await run(shell, 'wbt install npm:cowsay-wasm');
        expect(installRes.exitCode).toBe(0);

        const runRes = await run(shell, 'cowsay-wasm Hello Generic WASM');
        expect(runRes.exitCode).toBe(0);
        expect(runRes.output.join('\n')).toContain('< Hello Generic WASM >');
    });

    it('installs and runs a custom .wasm binary from a URL (`wbt install <name> <url>`)', async () => {
        const installRes = await run(shell, 'wbt install mywasm https://example.com/hello.wasm');
        expect(installRes.exitCode).toBe(0);
        expect(installRes.output.join('\n')).toContain('Setting up mywasm');

        const execRes = await run(shell, 'mywasm');
        expect(execRes.exitCode).toBe(0);
    });

    it('supports `wbt run <pkg> [args...]` without permanently installing the binary', async () => {
        const runRes = await run(shell, 'wbt run quickjs -e "21 * 2"');
        expect(runRes.exitCode).toBe(0);
        expect(runRes.output).toContain('42');

        const checkRes = await run(shell, 'which qjs');
        expect(checkRes.exitCode).toBeGreaterThan(0);
    });
});

describe('WBT interactive REPL mode', () => {
    let shell;

    beforeEach(async () => {
        await daemonManager.stopAll();
        pgliteInstances.clear();
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install sqlite3 pglite');
    });

    it('enters interactive REPL mode when `sqlite3` is invoked with no query and evaluates keystrokes until .exit', async () => {
        let interactiveFired = false;
        shell.once('interactive', () => { interactiveFired = true; });

        const screens = [];
        const onOut = (line) => screens.push(line);
        shell.on('stdOut', onOut);

        const cmdPromise = shell.onCommand('sqlite3 /home/interactive.db');

        await new Promise(r => setTimeout(r, 20));
        expect(interactiveFired).toBe(true);

        const query = 'CREATE TABLE t (x INT); INSERT INTO t VALUES (7); SELECT * FROM t;';
        for (const ch of query) {
            shell.onInput(ch);
        }
        shell.onInput('Enter');

        await new Promise(r => setTimeout(r, 20));
        expect(screens[screens.length - 1]).toContain('7');

        for (const ch of '.exit') {
            shell.onInput(ch);
        }
        shell.onInput('Enter');

        await cmdPromise;
        shell.removeListener('stdOut', onOut);

        expect(shell.context.fs.exists('/home/interactive.db')).toBe(true);
    });

    it('enters interactive REPL mode when `pglite` is invoked with no query and exits on Ctrl+D (^D)', async () => {
        let interactiveFired = false;
        shell.once('interactive', () => { interactiveFired = true; });

        const screens = [];
        const onOut = (line) => screens.push(line);
        shell.on('stdOut', onOut);

        const cmdPromise = shell.onCommand('pglite');

        await new Promise(r => setTimeout(r, 20));
        expect(interactiveFired).toBe(true);

        for (const ch of 'SELECT 123 AS val;') {
            shell.onInput(ch);
        }
        shell.onInput('Enter');

        await new Promise(r => setTimeout(r, 20));
        expect(screens[screens.length - 1]).toContain('123');

        shell.onInput('^D');
        await cmdPromise;
        shell.removeListener('stdOut', onOut);
    });
});

describe('Direct .wasm binary in /bin (without wbt) and standardized --help across all WASM bins', () => {
    it('executes a raw WASI .wasm binary placed directly in /bin by bare command name and supports --help', async () => {
        const b64 = Buffer.from(MINIMAL_WASM_BYTES).toString('base64');
        const shell = await createShell({
            filesystem: {
                bin: {
                    myjq: `data:application/wasm;base64,${b64}`
                }
            },
            permissions: {
                '/bin/myjq': 0o755
            }
        });

        // Bare command lookup in PATH ('myjq') automatically wraps the .wasm binary in WasmCommand!
        const { exitCode } = await run(shell, 'myjq');
        expect(exitCode).toBe(0);

        const helpRes = await run(shell, 'myjq --help');
        expect(helpRes.exitCode).toBe(0);
        const helpText = helpRes.output.join('\n');
        expect(helpText).toContain('Usage: myjq [options] [args...]');
        expect(helpText).toContain('-h, --help');
        expect(helpText).toContain('-V, --version');
    });

    it('provides a standardized --help format across registry, REPL, daemon, npm:<pkg>, and custom URL WASM binaries', async () => {
        const shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install jq python3 pglite npm:cowsay-wasm');
        await run(shell, 'wbt install mywasm https://example.com/hello.wasm');

        for (const bin of ['jq', 'python3', 'pglite', 'pg_ctl', 'cowsay-wasm', 'mywasm']) {
            const { output, exitCode } = await run(shell, `${bin} --help`);
            expect(exitCode).toBe(0);
            const text = output.join('\n');
            expect(text).toContain('wasm) —');
            expect(text).toContain('Usage:');
            expect(text).toContain('Options:');
            expect(text).toContain('-h, --help');
            expect(text).toContain('-V, --version');
        }
    });
});


import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
const Wpt = require('../lib/wpt/index.js');
const { daemonManager } = require('../lib/wpt/index.js');
const { pgliteInstances } = require('../lib/wpt/packages/pglite.js');

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
 * In-memory mock implementation of sql.js so sqlite3 WASM tests run deterministically offline.
 */
function createMockSqlJs() {
    class MockDatabase {
        constructor(bytes) {
            this._tables = {};
            if (bytes && bytes.length > 0) {
                try {
                    const text = new TextDecoder().decode(bytes);
                    const parsed = JSON.parse(text);
                    if (parsed && parsed._tables) {
                        this._tables = parsed._tables;
                    }
                } catch {
                    // ignore invalid bytes
                }
            }
        }

        exec(sql) {
            const results = [];
            const statements = sql
                .split(';')
                .map(s => s.trim())
                .filter(Boolean);

            for (const stmt of statements) {
                if (/^SELECT\s+name\s+FROM\s+sqlite_master/i.test(stmt)) {
                    const names = Object.keys(this._tables).sort().map(n => [n]);
                    if (names.length > 0) {
                        results.push({ columns: ['name'], values: names });
                    }
                    continue;
                }
                if (/^SELECT\s+sql\s+FROM\s+sqlite_master/i.test(stmt)) {
                    const sqls = Object.values(this._tables).map(t => [t.createSql]);
                    if (sqls.length > 0) {
                        results.push({ columns: ['sql'], values: sqls });
                    }
                    continue;
                }

                const createMatch = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\((.+)\)/i);
                if (createMatch) {
                    const tbl = createMatch[1];
                    const cols = createMatch[2].split(',').map(c => c.trim().split(/\s+/)[0]);
                    this._tables[tbl] = { columns: cols, rows: [], createSql: stmt };
                    continue;
                }

                const insertMatch = stmt.match(/^INSERT\s+INTO\s+(\w+)(?:\s*\(([^)]+)\))?\s+VALUES\s*\((.+)\)/i);
                if (insertMatch) {
                    const tbl = insertMatch[1];
                    if (!this._tables[tbl]) throw new Error(`no such table: ${tbl}`);
                    const rawVals = insertMatch[3].split(',').map(v => {
                        const s = v.trim();
                        if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
                            return s.slice(1, -1);
                        }
                        const n = Number(s);
                        return Number.isNaN(n) ? s : n;
                    });
                    this._tables[tbl].rows.push(rawVals);
                    continue;
                }

                const selectTableMatch = stmt.match(/^SELECT\s+(.+)\s+FROM\s+(\w+)/i);
                if (selectTableMatch) {
                    const tbl = selectTableMatch[2];
                    if (!this._tables[tbl]) throw new Error(`no such table: ${tbl}`);
                    const tableObj = this._tables[tbl];
                    results.push({
                        columns: tableObj.columns,
                        values: tableObj.rows
                    });
                    continue;
                }

                const selectExprMatch = stmt.match(/^SELECT\s+(.+)/i);
                if (selectExprMatch) {
                    const exprs = selectExprMatch[1].split(',').map(e => e.trim());
                    const cols = [];
                    const row = [];
                    for (const expr of exprs) {
                        const asMatch = expr.match(/^(.+?)\s+AS\s+(\w+)$/i);
                        const rawExpr = asMatch ? asMatch[1].trim() : expr;
                        const colName = asMatch ? asMatch[2] : rawExpr;
                        cols.push(colName);
                        if ((rawExpr.startsWith("'") && rawExpr.endsWith("'")) || (rawExpr.startsWith('"') && rawExpr.endsWith('"'))) {
                            row.push(rawExpr.slice(1, -1));
                        } else if (/^[\d\s+\-*/%()]+$/.test(rawExpr)) {
                            row.push(Function(`return (${rawExpr})`)());
                        } else {
                            row.push(rawExpr);
                        }
                    }
                    results.push({ columns: cols, values: [row] });
                    continue;
                }

                throw new Error(`syntax error near "${stmt}"`);
            }
            return results;
        }

        export() {
            const json = JSON.stringify({ _tables: this._tables });
            return new TextEncoder().encode(json);
        }

        close() {}
    }

    return async () => ({ Database: MockDatabase });
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
 * Mock AssemblyScript compiler (`assemblyscript/asc`).
 */
function createMockAsc() {
    return {
        ready: Promise.resolve(),
        async main(args, options) {
            let inputFile = null;
            let outFile = null;
            let textFile = null;
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if ((a === '-o' || a === '--outFile') && i + 1 < args.length) {
                    outFile = args[++i];
                } else if ((a === '-t' || a === '--textFile') && i + 1 < args.length) {
                    textFile = args[++i];
                } else if (!a.startsWith('-')) {
                    inputFile = a;
                }
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
                // If source contains `__eval`, emit the 42.0 evaluator binary
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
 * Mock QuickJS-Emscripten module.
 */
function createMockQuickJs() {
    return {
        async getQuickJS() {
            return {
                newContext() {
                    return {
                        evalCode(code) {
                            const val = Function(`return (${code})`)();
                            return val;
                        },
                        dispose() {}
                    };
                },
                evalCode(code) {
                    return Function(`return (${code})`)();
                }
            };
        }
    };
}

/**
 * Mock Lua (wasmoon) module.
 */
function createMockLua() {
    class LuaFactory {
        async createEngine() {
            let printFn = () => {};
            return {
                global: {
                    set(name, fn) {
                        if (name === 'print') printFn = fn;
                    },
                    close() {}
                },
                async doString(code) {
                    const printMatch = code.match(/print\(['"](.+?)['"]\)/);
                    if (printMatch) {
                        printFn(printMatch[1]);
                        return undefined;
                    }
                    const retMatch = code.match(/^return\s+(.+)$/);
                    if (retMatch) {
                        return Function(`return (${retMatch[1]})`)();
                    }
                    return undefined;
                }
            };
        }
    }
    return { LuaFactory };
}

/**
 * Mock jq-web module.
 */
function createMockJq() {
    return {
        async json(data, filter) {
            if (filter === '.' || !filter) return data;
            // Simple path traversal `.a.b` or `.users[].name`
            const parts = filter.replace(/^\./, '').split('.');
            let cur = data;
            for (const p of parts) {
                if (p.endsWith('[]')) {
                    const key = p.slice(0, -2);
                    cur = key ? cur[key] : cur;
                } else if (Array.isArray(cur)) {
                    cur = cur.map(item => item[p]);
                } else if (cur && typeof cur === 'object') {
                    cur = cur[p];
                }
            }
            return cur;
        }
    };
}

/**
 * Mock Pyodide module.
 */
function createMockPyodide() {
    let stdoutBatch = () => {};
    return {
        async loadPyodide() {
            return {
                setStdout({ batched }) { stdoutBatch = batched; },
                setStderr() {},
                async runPythonAsync(code) {
                    const printMatch = code.match(/print\(['"](.+?)['"]\)/);
                    if (printMatch) {
                        stdoutBatch(printMatch[1]);
                        return undefined;
                    }
                    if (/^[\d\s+\-*/%()]+$/.test(code.trim())) {
                        return Function(`return (${code})`)();
                    }
                    return undefined;
                }
            };
        }
    };
}

/**
 * Mock DuckDB-WASM module.
 */
function createMockDuckDb() {
    return {
        async createConnection() {
            return {
                async query(sql) {
                    if (/SELECT\s+100\s+AS\s+total/i.test(sql)) {
                        return { columns: ['total'], rows: [[100]] };
                    }
                    return { columns: ['ok'], rows: [[1]] };
                },
                async close() {}
            };
        }
    };
}

/**
 * Mock Graphviz WASM module.
 */
function createMockGraphviz() {
    return {
        Graphviz: {
            async load() {
                return {
                    async layout(dotSource, format) {
                        if (format === 'svg') {
                            return `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${dotSource.trim()} --></svg>`;
                        }
                        return dotSource;
                    }
                };
            }
        }
    };
}

/**
 * Mock FFmpeg WASM module.
 */
function createMockFfmpeg() {
    class MockFFmpeg {
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
    }
    return { FFmpeg: MockFFmpeg };
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

function createTestWpt() {
    return Wpt.configure({
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

describe('WPT optional package behavior', () => {
    it('is NOT included in a default Shell instance unless registered', async () => {
        const shell = await createShell();
        const { errors, exitCode } = await run(shell, 'wpt list');
        expect(exitCode).toBe(1);
        expect(errors.join(' ')).toMatch(/Command not found/i);
    });

    it('can be registered into a Shell instance via shell.context.setCommand(Wpt)', async () => {
        const shell = await createShell();
        shell.context.setCommand(createTestWpt());
        const { output, exitCode } = await run(shell, 'wpt --version');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('wpt 1.1.0');
    });
});

describe('WPT CLI subcommands (list, search, show, install, remove, update)', () => {
    let shell;

    beforeEach(async () => {
        await daemonManager.stopAll();
        pgliteInstances.clear();
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWpt());
    });

    it('shows help when run with no arguments or --help', async () => {
        const { output, exitCode } = await run(shell, 'wpt');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('Web Package Tool');
        expect(text).toContain('pglite');
        expect(text).toContain('sqlite3');
        expect(text).toContain('assemblyscript');
        expect(text).toContain('jq');
        expect(text).toContain('python3');
        expect(text).toContain('duckdb');
        expect(text).toContain('graphviz');
        expect(text).toContain('ffmpeg');
    });

    it('lists available packages with `wpt list` and installed packages with `wpt list --installed`', async () => {
        const allRes = await run(shell, 'wpt list');
        expect(allRes.exitCode).toBe(0);
        expect(allRes.output.join('\n')).toContain('pglite/wasm');
        expect(allRes.output.join('\n')).toContain('sqlite3/wasm');
        expect(allRes.output.join('\n')).toContain('assemblyscript/wasm');

        const emptyInstalled = await run(shell, 'wpt list --installed');
        expect(emptyInstalled.exitCode).toBe(0);
        expect(emptyInstalled.output).toEqual(['Listing...']);

        await run(shell, 'wpt install sqlite3');
        const afterInstall = await run(shell, 'wpt list --installed');
        expect(afterInstall.output.join('\n')).toContain('sqlite3/wasm');
        expect(afterInstall.output.join('\n')).toContain('[installed]');
    });

    it('searches packages by keyword with `wpt search`', async () => {
        const { output, exitCode } = await run(shell, 'wpt search postgres');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('pglite/wasm');
        expect(output.join('\n')).not.toContain('lua/wasm');
    });

    it('shows detailed package metadata with `wpt show`', async () => {
        const { output, exitCode } = await run(shell, 'wpt show pglite');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('Package: pglite');
        expect(text).toContain('State: not installed');
        expect(text).toContain('Binary: pglite');

        await run(shell, 'wpt install pglite');
        const afterShow = await run(shell, 'wpt show pglite');
        expect(afterShow.output.join('\n')).toContain('State: installed');
    });

    it('returns an error when installing an unknown package', async () => {
        const { errors, exitCode } = await run(shell, 'wpt install nonexistent-wasm-pkg');
        expect(exitCode).toBe(100);
        expect(errors.join(' ')).toContain('Unable to locate package nonexistent-wasm-pkg');
    });

    it('removes an installed package and unregisters its binary from /bin', async () => {
        await run(shell, 'wpt install sqlite3');
        const check1 = await run(shell, 'which sqlite3');
        expect(check1.output.join('')).toContain('/bin/sqlite3');

        const rmRes = await run(shell, 'wpt remove sqlite3');
        expect(rmRes.exitCode).toBe(0);
        expect(rmRes.output.join('\n')).toContain('Removing sqlite3');

        const check2 = await run(shell, 'sqlite3 --version');
        expect(check2.exitCode).toBe(1);
        expect(check2.errors.join(' ')).toMatch(/Command not found/i);
    });

    it('updates remote sources with `wpt update`', async () => {
        const { output, exitCode } = await run(shell, 'wpt update');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('Reading package lists... Done');

        const showCustom = await run(shell, 'wpt show custompkg');
        expect(showCustom.exitCode).toBe(0);
        expect(showCustom.output.join('\n')).toContain('Remote registry test package');
    });

    it('restores installed commands from /var/lib/wpt/installed.json via Wpt.restoreInstalled', async () => {
        await run(shell, 'wpt install sqlite3');
        const rawFs = shell.context.fs.getRaw();
        const rawPerms = shell.context.fs.getRawPermissions();

        const savedInstalledJson = rawFs.var.lib.wpt['installed.json'];
        const shell2 = await createShell({
            filesystem: {
                var: { lib: { wpt: { 'installed.json': savedInstalledJson } } }
            },
            permissions: rawPerms
        });
        const TestWpt = createTestWpt();
        shell2.context.setCommand(TestWpt);
        TestWpt.restoreInstalled(shell2);

        const { output, exitCode } = await run(shell2, 'sqlite3 --version');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('sql.js');
    });
});

describe('WPT SQLite3 WASM package (`sqlite3` / `sqlite`)', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWpt());
        await run(shell, 'wpt install sqlite');
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

describe('WPT PGlite WASM package (`pglite`, `psql`, `pg_ctl` & background server daemon)', () => {
    let shell;

    beforeEach(async () => {
        await daemonManager.stopAll();
        pgliteInstances.clear();
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWpt());
        await run(shell, 'wpt install pglite');
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

        // Verify `wpt services` lists the running daemon
        const svcRes = await run(shell, 'wpt services');
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

describe('WPT AssemblyScript compiler (`asc`) and JIT/AOT runtime (`asrun` / `asnode`)', () => {
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
        shell.context.setCommand(createTestWpt());
        await run(shell, 'wpt install assemblyscript');
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

describe('WPT Curated WASM Tools (`jq`, `python3`, `duckdb`, `dot`, `ffmpeg`) & Generic Runtime', () => {
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
        shell.context.setCommand(createTestWpt());
    });

    it('processes JSON files and piped JSON with `jq`', async () => {
        await run(shell, 'wpt install jq');
        const res = await run(shell, 'cat /home/data.json | jq -r ".user.name"');
        expect(res.exitCode).toBe(0);
        expect(res.output).toContain('Ada');
    });

    it('runs Python 3 scripts and `-c` expressions with `python3` / `python`', async () => {
        await run(shell, 'wpt install python3');
        const scriptRes = await run(shell, 'python3 /home/hello.py');
        expect(scriptRes.exitCode).toBe(0);
        expect(scriptRes.output).toContain('Hello from Pyodide!');

        const evalRes = await run(shell, 'python -c "6 * 7"');
        expect(evalRes.exitCode).toBe(0);
        expect(evalRes.output).toContain('42');
    });

    it('runs analytical SQL queries with `duckdb`', async () => {
        await run(shell, 'wpt install duckdb');
        const res = await run(shell, 'duckdb -c "SELECT 100 AS total"');
        expect(res.exitCode).toBe(0);
        expect(res.output.join('\n')).toContain('100');
    });

    it('compiles Graphviz DOT files to SVG with `dot` (`graphviz` package)', async () => {
        await run(shell, 'wpt install graphviz');
        const res = await run(shell, 'dot -Tsvg /home/graph.dot -o /home/graph.svg');
        expect(res.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/graph.svg')).toBe(true);
        expect(shell.context.fs.getFileByPath('/home/graph.svg')).toContain('<svg');
    });

    it('transcodes media files in the brsh filesystem with `ffmpeg`', async () => {
        await run(shell, 'wpt install ffmpeg');
        const res = await run(shell, 'ffmpeg -i /home/input.mp4 /home/output.webm');
        expect(res.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/output.webm')).toBe(true);
    });

    it('wraps arbitrary Emscripten / NPM packages at runtime without a custom adapter (`wpt install npm:<pkg>`)', async () => {
        const installRes = await run(shell, 'wpt install npm:cowsay-wasm');
        expect(installRes.exitCode).toBe(0);

        const runRes = await run(shell, 'cowsay-wasm Hello Generic WASM');
        expect(runRes.exitCode).toBe(0);
        expect(runRes.output.join('\n')).toContain('< Hello Generic WASM >');
    });

    it('installs and runs a custom .wasm binary from a URL (`wpt install <name> <url>`)', async () => {
        const installRes = await run(shell, 'wpt install mywasm https://example.com/hello.wasm');
        expect(installRes.exitCode).toBe(0);
        expect(installRes.output.join('\n')).toContain('Setting up mywasm');

        const execRes = await run(shell, 'mywasm');
        expect(execRes.exitCode).toBe(0);
    });

    it('supports `wpt run <pkg> [args...]` without permanently installing the binary', async () => {
        const runRes = await run(shell, 'wpt run quickjs -e "21 * 2"');
        expect(runRes.exitCode).toBe(0);
        expect(runRes.output).toContain('42');

        const checkRes = await run(shell, 'which qjs');
        expect(checkRes.exitCode).toBeGreaterThan(0);
    });
});

describe('WPT interactive REPL mode', () => {
    let shell;

    beforeEach(async () => {
        await daemonManager.stopAll();
        pgliteInstances.clear();
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWpt());
        await run(shell, 'wpt install sqlite3 pglite');
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

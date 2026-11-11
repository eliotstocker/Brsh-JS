import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
const path = require('path');
const fs = require('fs');
const Wbt = require('../lib/wbt/index.js');
const { wllamaInstances, DEFAULT_MODEL_URL, MODEL_ALIASES, resolveModelSpec } = require('../lib/wbt/packages/wllama.js');

const FIXTURE_NANO_WASM = path.resolve(import.meta.dirname, 'fixtures/nano.wasm');
const NANO_WASM_PATH = path.resolve(import.meta.dirname, '../../nano-wasm/dist/nano.wasm');
const NANO_WASM_BYTES = (() => {
    try {
        if (fs.existsSync(FIXTURE_NANO_WASM)) {
            return new Uint8Array(fs.readFileSync(FIXTURE_NANO_WASM));
        }
        if (fs.existsSync(NANO_WASM_PATH)) {
            return new Uint8Array(fs.readFileSync(NANO_WASM_PATH));
        }
    } catch { /* ignore */ }
    return null;
})();

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
            if (args.includes('--help') || args.includes('-h')) {
                io.stdout('jq - commandline JSON processor [version 1.7.1]');
                io.stdout('Usage: jq [options] <jq filter> [file...]');
                io.stdout('  -c, --compact-output  compact instead of pretty-printed output;');
                io.stdout('  -n, --null-input      use `null` as the single input value;');
                io.stdout('  -r, --raw-output      output raw strings, not JSON texts;');
                io.stdout('  -s, --slurp           read (slurp) all inputs into an array;');
                return 0;
            }
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

/**
 * In-memory mock implementation of @wllama/wllama v3 for deterministic tests.
 */
function createMockWllama() {
    class MockWllama {
        constructor(pathConfig, config = {}) {
            this.pathConfig = pathConfig;
            this.config = config;
            this._loaded = false;
            this._loadParams = {};
            this._modelSource = null;
            this.modelManager = {
                getModels: async () => []
            };
        }

        static getLibllamaVersion() {
            return 'b6327-4d74393';
        }

        isSupportWebGPU() {
            return true;
        }

        isMultithread() {
            return true;
        }

        getNumThreads() {
            return 4;
        }

        isModelLoaded() {
            return this._loaded;
        }

        getModelMetadata() {
            return {
                hparams: { nVocab: 32000, nCtxTrain: 4096, nEmbd: 2048, nLayer: 22 },
                meta: { 'general.name': 'TinyLlama-1.1B' }
            };
        }

        async loadModel(blobs, params = {}) {
            this._loaded = true;
            this._loadParams = params;
            this._modelSource = blobs.map(b => b.name || 'blob.gguf').join('+');
        }

        async loadModelFromUrl(urlOrObj, params = {}) {
            if (typeof params.progressCallback === 'function') {
                params.progressCallback({ loaded: 524288, total: 1048576 });
                params.progressCallback({ loaded: 1048576, total: 1048576 });
            }
            this._loaded = true;
            this._loadParams = params;
            this._modelSource = typeof urlOrObj === 'string' ? urlOrObj : urlOrObj.url;
        }

        async loadModelFromHF(hfOpts, params = {}) {
            if (typeof params.progressCallback === 'function') {
                params.progressCallback({ loaded: 524288, total: 1048576 });
                params.progressCallback({ loaded: 1048576, total: 1048576 });
            }
            this._loaded = true;
            this._loadParams = params;
            this._modelSource = `hf:${hfOpts.repo}:${hfOpts.quant || 'Q4_K_M'}`;
        }

        async getLoadedBlob() {
            return new Uint8Array([0x47, 0x47, 0x55, 0x46, 0x03, 0x00, 0x00, 0x00]);
        }

        createChatCompletion(opts) {
            const messages = (opts && opts.messages) || [];
            const sysMsg = messages.find(m => m.role === 'system');
            const userMsgs = messages.filter(m => m.role === 'user').map(m => m.content);
            const prefix = sysMsg ? `[sys:${sysMsg.content}] ` : '';
            const gpuTag = this._loadParams.n_gpu_layers === 0 ? 'CPU' : 'WebGPU';
            const reply = `${prefix}Reply(${gpuTag},turns=${userMsgs.length}): ${userMsgs[userMsgs.length - 1] || ''}`;

            if (opts && opts.stream) {
                return (async function* () {
                    const parts = reply.split(' ');
                    for (let i = 0; i < parts.length; i++) {
                        const token = (i === 0 ? '' : ' ') + parts[i];
                        yield {
                            id: 'chatcmpl-wllama',
                            choices: [{ delta: { content: token } }]
                        };
                    }
                })();
            }

            return Promise.resolve({
                id: 'chatcmpl-wllama',
                object: 'chat.completion',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: reply },
                        finish_reason: 'stop'
                    }
                ]
            });
        }

        createCompletion(opts) {
            const reply = `${opts.prompt} [completed]`;
            if (opts && opts.stream) {
                return (async function* () {
                    const parts = reply.split(' ');
                    for (let i = 0; i < parts.length; i++) {
                        const token = (i === 0 ? '' : ' ') + parts[i];
                        yield {
                            id: 'cmpl-wllama',
                            choices: [{ text: token }]
                        };
                    }
                })();
            }

            return Promise.resolve({
                id: 'cmpl-wllama',
                object: 'text_completion',
                choices: [
                    {
                        index: 0,
                        text: reply,
                        finish_reason: 'stop'
                    }
                ]
            });
        }

        async createEmbedding(opts) {
            const text = String(opts.input || '');
            return {
                object: 'list',
                data: [
                    {
                        object: 'embedding',
                        index: 0,
                        embedding: [text.length, 0.25, 0.5, 0.75]
                    }
                ]
            };
        }

        async testBackendOps() {
            return { retcode: 0, success: true };
        }

        async exit() {
            this._loaded = false;
        }
    }

    return {
        Wllama: MockWllama,
        LoggerWithoutDebug: console
    };
}

function createTestWbt() {
    return Wbt.configure({
        moduleLoader: async (pkgName) => {
            if (pkgName === 'sql.js' || pkgName === 'sqlite3') return createMockSqlJs();
            if (pkgName === '@wllama/wllama' || pkgName === 'wllama') return createMockWllama();
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
            if ((url.includes('nano-wasm') || url.includes('nano.wasm')) && NANO_WASM_BYTES) {
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => NANO_WASM_BYTES.buffer
                };
            }
            if (url.includes('/bin/freedoom')) {
                const scriptPath = path.resolve(import.meta.dirname, '../../eliotstocker/doom-wasm/bin/freedoom');
                const scriptText = fs.existsSync(scriptPath)
                    ? fs.readFileSync(scriptPath, 'utf8')
                    : [
                        '#!/bin/sh',
                        'WAD_DIR="/usr/share/games/doom"',
                        'WAD_NAME="freedoom1.wad"',
                        'WAD_URL="https://raw.githubusercontent.com/redox-os/freedoom/master/freedoom1.wad"',
                        'EXTRA_ARGS=""',
                        'for ARG in $@',
                        'do',
                        '    case "$ARG" in',
                        '        --phase2|--freedoom2|-2)',
                        '            WAD_NAME="freedoom2.wad"',
                        '            WAD_URL="https://raw.githubusercontent.com/redox-os/freedoom/master/freedoom2.wad"',
                        '            ;;',
                        '        --help|-h)',
                        '            echo "Usage: freedoom [--phase1 | --phase2] [doom options...]"',
                        '            return 0',
                        '            ;;',
                        '        *)',
                        '            EXTRA_ARGS="$EXTRA_ARGS $ARG"',
                        '            ;;',
                        '    esac',
                        'done',
                        'WAD_FILE="$WAD_DIR/$WAD_NAME"',
                        'if [ ! -f "$WAD_FILE" ]; then',
                        '    mkdir -p "$WAD_DIR"',
                        '    curl -# -L -o "$WAD_FILE" "$WAD_URL"',
                        'fi',
                        'doom -iwad "$WAD_FILE" -nosound $EXTRA_ARGS'
                    ].join('\n');
                return {
                    ok: true,
                    status: 200,
                    text: async () => scriptText
                };
            }
            if (url === 'https://example.com/hello.wasm' || /\.wasm(\?.*)?$/i.test(url)) {
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
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
    });

    it('shows help when run with no arguments or --help', async () => {
        const { output, exitCode } = await run(shell, 'wbt');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('Web Binary Tool');
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
        expect(allRes.output.join('\n')).toContain('sqlite3/wasm');
        expect(allRes.output.join('\n')).toContain('assemblyscript/wasm');
        expect(allRes.output.join('\n')).toContain('duckdb/wasm');

        const emptyInstalled = await run(shell, 'wbt list --installed');
        expect(emptyInstalled.exitCode).toBe(0);
        expect(emptyInstalled.output).toEqual(['Listing...']);

        await run(shell, 'wbt install sqlite3');
        const afterInstall = await run(shell, 'wbt list --installed');
        expect(afterInstall.output.join('\n')).toContain('sqlite3/wasm');
        expect(afterInstall.output.join('\n')).toContain('[installed]');
    });

    it('searches packages by keyword with `wbt search`', async () => {
        const { output, exitCode } = await run(shell, 'wbt search json');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toContain('jq/wasm');
        expect(output.join('\n')).not.toContain('lua/wasm');
    });

    it('shows detailed package metadata with `wbt show`', async () => {
        const { output, exitCode } = await run(shell, 'wbt show sqlite3');
        expect(exitCode).toBe(0);
        const text = output.join('\n');
        expect(text).toContain('Package: sqlite3');
        expect(text).toContain('State: not installed');
        expect(text).toContain('Binary: sqlite3');

        await run(shell, 'wbt install sqlite3');
        const afterShow = await run(shell, 'wbt show sqlite3');
        expect(afterShow.output.join('\n')).toContain('State: installed');
    });

    it('returns an error when installing an unknown package', async () => {
        const { errors, exitCode } = await run(shell, 'wbt install nonexistent-wasm-pkg');
        expect(exitCode).toBe(100);
        expect(errors.join(' ')).toContain('Unable to locate package nonexistent-wasm-pkg');
    });

    it('pulls and persists the .wasm binary to /var/lib/wbt/wasm/<pkg>.wasm on `wbt install` and removes it on `wbt remove`', async () => {
        const fetchedUrls = [];
        const BaseWbt = createTestWbt();
        const TrackingWbt = BaseWbt.configure({
            fetch: async (url) => {
                fetchedUrls.push(url);
                return BaseWbt._config.fetch(url);
            }
        });
        shell.context.setCommand(TrackingWbt);

        const installRes = await run(shell, 'wbt install sqlite3');
        expect(installRes.exitCode).toBe(0);
        expect(fetchedUrls.some(u => u.includes('sql-wasm.wasm'))).toBe(true);
        expect(shell.context.fs.exists('/usr/lib/sqlite3/sqlite3.wasm')).toBe(true);

        const showRes = await run(shell, 'wbt show sqlite3');
        expect(showRes.output.join('\n')).toContain('WASM-File: /usr/lib/sqlite3/sqlite3.wasm');

        await run(shell, 'wbt remove sqlite3');
        expect(shell.context.fs.exists('/usr/lib/sqlite3/sqlite3.wasm')).toBe(false);
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

    it('treats /usr/lib/<pkg>/ as the single source of truth without creating /var/lib/wbt/installed.json', async () => {
        await run(shell, 'wbt install sqlite3');
        expect(shell.context.fs.exists('/var/lib/wbt/installed.json')).toBe(false);
        expect(shell.context.fs.exists('/usr/lib/sqlite3/package.json')).toBe(true);

        const rawFs = shell.context.fs.getRaw();
        const rawPerms = shell.context.fs.getRawPermissions();

        // Restore filesystem into a new shell from the directory structure alone
        const shell2 = await createShell({
            filesystem: {
                usr: rawFs.usr,
                bin: rawFs.bin
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

    it('installs and runs a custom .wasm binary from a URL (`wbt install <name> <url>`) and supports mixing multiple packages with `<name> <url>` pairs', async () => {
        // 1. Single `<name> <url>`
        const installRes = await run(shell, 'wbt install mywasm https://example.com/hello.wasm');
        expect(installRes.exitCode).toBe(0);
        expect(installRes.output.join('\n')).toContain('Setting up mywasm');

        const execRes = await run(shell, 'mywasm');
        expect(execRes.exitCode).toBe(0);

        // 2. Mixed multiple registry packages AND `<name> <url>` in one command
        const mixedRes = await run(shell, 'wbt install jq otherwasm https://example.com/hello.wasm python3');
        expect(mixedRes.exitCode).toBe(0);
        const mixedOut = mixedRes.output.join('\n');
        expect(mixedOut).toContain('Setting up jq');
        expect(mixedOut).toContain('Setting up otherwasm');
        expect(mixedOut).toContain('Setting up python3');

        expect((await run(shell, 'otherwasm')).exitCode).toBe(0);
        expect((await run(shell, 'python3 -c "2 + 2"')).output).toContain('4');
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
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install sqlite3');
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

    it('passes through native --help when a WASM binary implements it and falls back to standardized --help otherwise', async () => {
        const shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install jq python3 npm:cowsay-wasm');
        await run(shell, 'wbt install mywasm https://example.com/hello.wasm');

        // 1. Binaries without their own `--help` get the standardized fallback `--help` screen
        for (const bin of ['python3', 'cowsay-wasm', 'mywasm']) {
            const { output, exitCode } = await run(shell, `${bin} --help`);
            expect(exitCode).toBe(0);
            const text = output.join('\n');
            expect(text).toContain('wasm) —');
            expect(text).toContain('Usage:');
            expect(text).toContain('Options:');
            expect(text).toContain('-h, --help');
            expect(text).toContain('-V, --version');
        }

        // 2. `jq` implements its own `--help` in main(args, io) -> passed through verbatim!
        const jqRes = await run(shell, 'jq --help');
        expect(jqRes.exitCode).toBe(0);
        const jqHelp = jqRes.output.join('\n');
        expect(jqHelp).toContain('jq - commandline JSON processor [version 1.7.1]');
        expect(jqHelp).toContain('Usage: jq [options] <jq filter> [file...]');
        expect(jqHelp).toContain('-r, --raw-output');
        expect(jqHelp).toContain('-c, --compact-output');

        // 3. `mywasm --help` introspects the compiled .wasm binary exports at runtime
        const mywasmHelp = (await run(shell, 'mywasm --help')).output.join('\n');
        expect(mywasmHelp).toContain('WASM Exports: _start');
    });

    it('introspects embedded Usage and CLI flags from a .wasm binary data section at runtime when the binary does not print help', async () => {
        // Append a custom section / data payload containing embedded C strings (`Usage: ...` and `--flag` lines)
        const embeddedStrings = new TextEncoder().encode(
            '\0Usage: customtool [-v] <input>\n' +
            '  -f, --format <fmt>  Output format\n' +
            '  --strict            Strict mode\0'
        );
        // Custom section (id 0) with name "rodata" + embedded strings (payloadLen < 128 so 1-byte LEB128)
        const secName = new TextEncoder().encode('rodata');
        const payloadLen = 1 + secName.length + embeddedStrings.length;
        const wasmWithData = new Uint8Array(MINIMAL_WASM_BYTES.length + 3 + secName.length + embeddedStrings.length);
        wasmWithData.set(MINIMAL_WASM_BYTES, 0);
        let offset = MINIMAL_WASM_BYTES.length;
        wasmWithData[offset++] = 0x00; // custom section id
        wasmWithData[offset++] = payloadLen;
        wasmWithData[offset++] = secName.length;
        wasmWithData.set(secName, offset);
        offset += secName.length;
        wasmWithData.set(embeddedStrings, offset);

        const b64 = Buffer.from(wasmWithData).toString('base64');
        const shell = await createShell({
            filesystem: {
                bin: {
                    customtool: `data:application/wasm;base64,${b64}`
                }
            },
            permissions: {
                '/bin/customtool': 0o755
            }
        });

        const helpRes = await run(shell, 'customtool --help');
        expect(helpRes.exitCode).toBe(0);
        const helpText = helpRes.output.join('\n');
        expect(helpText).toContain('Usage: customtool [-v] <input>');
        expect(helpText).toContain('-f, --format <fmt>  Output format');
        expect(helpText).toContain('--strict            Strict mode');
        expect(helpText).toContain('WASM Exports: _start');
    });
});

describe('WBT Wllama v3 WASM & WebGPU package (`wllama`, `llama`, `llama-cli`)', () => {
    let shell;

    beforeEach(async () => {
        wllamaInstances.clear();
        shell = await createShell({
            filesystem: {
                home: {
                    'tinyllama.gguf': 'GGUF_MODEL_BINARY_BYTES',
                    'prompt.txt': 'Explain WebGPU in one sentence.'
                }
            }
        });
        shell.context.setCommand(createTestWbt());
        await run(shell, 'wbt install wllama');
    });

    it('registers wllama, llama, and llama-cli binaries and supports --help / --version', async () => {
        for (const bin of ['wllama', 'llama', 'llama-cli']) {
            const whichRes = await run(shell, `which ${bin}`);
            expect(whichRes.exitCode).toBe(0);
            expect(whichRes.output.join('')).toContain(`/bin/${bin}`);
        }

        const helpRes = await run(shell, 'wllama --help');
        expect(helpRes.exitCode).toBe(0);
        expect(helpRes.output.join('\n')).toContain('WebGPU');
        expect(helpRes.output.join('\n')).toContain('--n-gpu-layers');

        const runHelpRes = await run(shell, 'wbt run wllama --help');
        expect(runHelpRes.exitCode).toBe(0);
        expect(runHelpRes.output.join('\n')).toContain('Usage: wllama');
    });

    it('runs one-shot chat completions from a local filesystem .gguf model, piped stdin, or -f file with WebGPU or --no-gpu', async () => {
        const res1 = await run(
            shell,
            'wllama -m /home/tinyllama.gguf -s "Be concise" -p "Hello Wllama 3!"'
        );
        expect(res1.exitCode).toBe(0);
        expect(res1.output.join('\n')).toContain('[sys:Be concise] Reply(WebGPU,turns=1): Hello Wllama 3!');

        // CPU fallback (--no-gpu / -ngl 0)
        const resCpu = await run(
            shell,
            'llama -m /home/tinyllama.gguf --no-gpu -p "CPU test"'
        );
        expect(resCpu.exitCode).toBe(0);
        expect(resCpu.output.join('\n')).toContain('Reply(CPU,turns=1): CPU test');

        // Piped stdin
        const piped = await run(
            shell,
            'echo "Piped prompt" | llama-cli -m /home/tinyllama.gguf'
        );
        expect(piped.exitCode).toBe(0);
        expect(piped.output.join('\n')).toContain('Reply(WebGPU,turns=1): Piped prompt');

        // File prompt (-f) and raw completion (--raw)
        const rawRes = await run(
            shell,
            'wllama -m /home/tinyllama.gguf --raw -f /home/prompt.txt'
        );
        expect(rawRes.exitCode).toBe(0);
        expect(rawRes.output.join('\n')).toContain('Explain WebGPU in one sentence. [completed]');
    });

    it('streams tokens in real time as they are generated and supports --no-stream', async () => {
        const streamedTokens = [];
        const rawChunks = [];
        const onToken = (token) => streamedTokens.push(token);
        const onRaw = (chunk) => rawChunks.push(chunk);

        shell.on('token', onToken);
        shell.on('stdOutRaw', onRaw);

        const res = await run(
            shell,
            'wllama -m /home/tinyllama.gguf -p "Stream me"'
        );

        shell.removeListener('token', onToken);
        shell.removeListener('stdOutRaw', onRaw);

        expect(res.exitCode).toBe(0);
        expect(res.output.join('\n')).toContain('Reply(WebGPU,turns=1): Stream me');
        // Verified tokens were streamed incrementally
        expect(streamedTokens.length).toBeGreaterThan(1);
        expect(streamedTokens.join('')).toContain('Stream me');
        expect(rawChunks.length).toBeGreaterThan(1);

        // Test with --no-stream flag
        const noStreamTokens = [];
        const onNoStreamToken = (token) => noStreamTokens.push(token);
        shell.on('token', onNoStreamToken);

        const noStreamRes = await run(
            shell,
            'wllama -m /home/tinyllama.gguf --no-stream -p "No stream"'
        );

        shell.removeListener('token', onNoStreamToken);

        expect(noStreamRes.exitCode).toBe(0);
        expect(noStreamRes.output.join('\n')).toContain('Reply(WebGPU,turns=1): No stream');
        expect(noStreamTokens.length).toBe(0);

        // Test status indication (loading model weights, running inference)
        wllamaInstances.clear();
        const statusUpdates = [];
        const onStatus = (chunk) => statusUpdates.push(chunk);
        shell.stderr.on('data', onStatus);

        await run(
            shell,
            'wllama -m /home/tinyllama.gguf -p "Status test"'
        );

        shell.stderr.removeListener('data', onStatus);
        const combinedStatus = statusUpdates.join('');
        expect(combinedStatus).toContain('Loading model (tinyllama.gguf) weights');
        expect(combinedStatus).toContain('Running inference');
        expect(combinedStatus).toMatch(/\[.*\]/);
    });

    it('supports Hugging Face model loading (--hf / hf:), embeddings (wllama embed), info, and bench', async () => {
        const hfRes = await run(
            shell,
            'wllama --hf Qwen/Qwen2.5-0.5B-Instruct-GGUF --quant Q4_K_M -p "From HF"'
        );
        expect(hfRes.exitCode).toBe(0);
        expect(hfRes.output.join('\n')).toContain('Reply(WebGPU,turns=1): From HF');

        const embRes = await run(
            shell,
            'wllama embed -m /home/tinyllama.gguf -p "hello"'
        );
        expect(embRes.exitCode).toBe(0);
        expect(JSON.parse(embRes.output.join(''))).toEqual([5, 0.25, 0.5, 0.75]);

        const infoRes = await run(shell, 'wllama info -m /home/tinyllama.gguf');
        expect(infoRes.exitCode).toBe(0);
        expect(infoRes.output.join('\n')).toContain('WebGPU:       enabled');
        expect(infoRes.output.join('\n')).toContain('layers=22');

        const benchRes = await run(shell, 'wllama bench');
        expect(benchRes.exitCode).toBe(0);
        expect(benchRes.output.join('\n')).toContain('PASSED');
    });

    it('enters interactive multi-turn chat REPL mode when `wllama` is invoked with no prompt', async () => {
        let interactiveFired = false;
        shell.once('interactive', () => { interactiveFired = true; });

        const screens = [];
        const onOut = (line) => screens.push(line);
        shell.on('stdOut', onOut);

        const cmdPromise = shell.onCommand('wllama -m /home/tinyllama.gguf');

        await new Promise(r => setTimeout(r, 20));
        expect(interactiveFired).toBe(true);

        for (const ch of 'First question') {
            shell.onInput(ch);
        }
        shell.onInput('Enter');
        await new Promise(r => setTimeout(r, 20));
        expect(screens[screens.length - 1]).toContain('Reply(WebGPU,turns=1): First question');

        for (const ch of 'Second question') {
            shell.onInput(ch);
        }
        shell.onInput('Enter');
        await new Promise(r => setTimeout(r, 20));
        expect(screens[screens.length - 1]).toContain('Reply(WebGPU,turns=2): Second question');

        shell.onInput('^D');
        await cmdPromise;
        shell.removeListener('stdOut', onOut);
    });

    it('persists pulled remote models to the brsh filesystem via `--persist`, `-o`, and `wllama pull`', async () => {
        // 1. Run with `--persist` (saves to default /var/cache/wllama/<filename>.gguf)
        const persistRes = await run(
            shell,
            'wllama --hf Qwen/Qwen2.5-0.5B-Instruct-GGUF --quant Q4_K_M --persist -p "Persist test"'
        );
        expect(persistRes.exitCode).toBe(0);
        expect(persistRes.output.join('\n')).toContain('Reply(WebGPU,turns=1): Persist test');
        expect(shell.context.fs.exists('/var/cache/wllama/Qwen2.5-0.5B-Instruct-GGUF-Q4_K_M.gguf')).toBe(true);

        // 2. Run with `-o` / `--output` to persist to a custom path
        const outRes = await run(
            shell,
            'wllama -m https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf -o /home/saved-stories.gguf -p "Saved custom"'
        );
        expect(outRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/home/saved-stories.gguf')).toBe(true);

        // 3. Dedicated `wllama pull` subcommand streams download progress bars
        const pullRes = await run(
            shell,
            'wllama pull hf:bartowski/SmolLM2-135M-Instruct-GGUF:Q4_K_M -o /home/smol.gguf'
        );
        expect(pullRes.exitCode).toBe(0);
        expect(pullRes.output.some(l => l.startsWith('\rPulling') && l.includes('50%'))).toBe(true);
        expect(pullRes.output.some(l => l.startsWith('\rPulling') && l.includes('100%'))).toBe(true);
        expect(pullRes.output.join('\n')).toContain('Persisted model');
        expect(pullRes.output.join('\n')).toContain('/home/smol.gguf');
        expect(shell.context.fs.exists('/home/smol.gguf')).toBe(true);

        // 4. `-q` / `--no-progress` suppresses the progress bar
        const quietRes = await run(
            shell,
            'wllama pull hf:ggml-org/models/tinyllamas/stories15M-q4_0.gguf -q -o /home/quiet.gguf'
        );
        expect(quietRes.exitCode).toBe(0);
        expect(quietRes.output.some(l => l.startsWith('\rPulling'))).toBe(false);
        expect(shell.context.fs.exists('/home/quiet.gguf')).toBe(true);

        // 5. Verify `wllama models` lists persisted models in `/var/cache/wllama`
        const modelsRes = await run(shell, 'wllama models');
        expect(modelsRes.exitCode).toBe(0);
        expect(modelsRes.output.join('\n')).toContain('/var/cache/wllama/Qwen2.5-0.5B-Instruct-GGUF-Q4_K_M.gguf');
        expect(modelsRes.output.join('\n')).toContain('persisted (fs)');
    });

    it('defaults to SmolLM2 model and supports friendly model aliases like smol and qwen', async () => {
        // Verify default model URL is SmolLM2-135M rather than stories
        expect(DEFAULT_MODEL_URL).toContain('SmolLM2-135M-Instruct');
        expect(DEFAULT_MODEL_URL).not.toContain('stories');

        // Verify resolveModelSpec helper maps empty input to SmolLM2 default
        const defaultSpec = resolveModelSpec();
        expect(defaultSpec.url).toBe(DEFAULT_MODEL_URL);
        expect(defaultSpec.url).toContain('SmolLM2-135M-Instruct-Q4_K_M.gguf');

        // Verify smol and qwen aliases
        const smolSpec = resolveModelSpec('smol');
        expect(smolSpec.url).toBe(MODEL_ALIASES.smol);
        const qwenSpec = resolveModelSpec('qwen');
        expect(qwenSpec.url).toBe(MODEL_ALIASES.qwen);
        expect(qwenSpec.url).toContain('qwen2.5-0.5b-instruct-q4_k_m.gguf');

        // Run wllama with no -m flag (uses default SmolLM2 model)
        const defaultRes = await run(shell, 'wllama -p "Default model prompt"');
        expect(defaultRes.exitCode).toBe(0);
        expect(defaultRes.output.join('\n')).toContain('Reply(WebGPU,turns=1): Default model prompt');

        // Run wllama pull using alias 'qwen'
        const pullQwenRes = await run(shell, 'wllama pull qwen -q');
        expect(pullQwenRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/var/cache/wllama/qwen2.5-0.5b-instruct-q4_k_m.gguf')).toBe(true);

        // Run wllama using alias 'qwen' with -m
        const qwenRes = await run(shell, 'wllama -m qwen -p "Hello Qwen"');
        expect(qwenRes.exitCode).toBe(0);
        expect(qwenRes.output.join('\n')).toContain('Reply(WebGPU,turns=1): Hello Qwen');
    });
});

describe('WBT GNU nano WASM package (nano / nano-wasm)', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell();
        shell.context.setCommand(createTestWbt());
    });

    it('registers nano and nano-wasm in registry, wbt search, and wbt show', async () => {
        const listRes = await run(shell, 'wbt list');
        expect(listRes.exitCode).toBe(0);
        expect(listRes.output.join('\n')).toContain('nano/wasm 8.0.1');

        const searchRes = await run(shell, 'wbt search editor');
        expect(searchRes.exitCode).toBe(0);
        expect(searchRes.output.join('\n')).toContain('nano');

        const showRes = await run(shell, 'wbt show nano');
        expect(showRes.exitCode).toBe(0);
        expect(showRes.output.join('\n')).toContain('Package: nano');
        expect(showRes.output.join('\n')).toContain('Version: 8.0.1');
        expect(showRes.output.join('\n')).toContain('Aliases: nano-wasm');

        const showAliasRes = await run(shell, 'wbt show nano-wasm');
        expect(showAliasRes.exitCode).toBe(0);
        expect(showAliasRes.output.join('\n')).toContain('Package: nano');
    });

    it('installs nano and nano-wasm into /bin and runs --version and --help', async () => {
        const installRes = await run(shell, 'wbt install nano');
        expect(installRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/usr/lib/nano/nano.wasm')).toBe(true);
        expect(shell.context.fs.exists('/bin/nano')).toBe(true);
        expect(shell.context.fs.exists('/bin/nano-wasm')).toBe(true);

        const verRes = await run(shell, 'nano --version');
        expect(verRes.exitCode).toBe(0);
        expect(verRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);

        const helpRes = await run(shell, 'nano --help');
        expect(helpRes.exitCode).toBe(0);
        expect(helpRes.output.join('\n')).toMatch(/Usage:\s+nano/i);

        const aliasVerRes = await run(shell, 'nano-wasm --version');
        expect(aliasVerRes.exitCode).toBe(0);
        expect(aliasVerRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);
    });

    it('supports wbt run nano --version without permanently installing', async () => {
        const runRes = await run(shell, 'wbt run nano --version');
        expect(runRes.exitCode).toBe(0);
        expect(runRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);
        expect(shell.context.fs.exists('/bin/nano')).toBe(false);
    });

    it('removes nano and unregisters both nano and nano-wasm from /bin', async () => {
        await run(shell, 'wbt install nano-wasm');
        expect(shell.context.fs.exists('/bin/nano')).toBe(true);
        expect(shell.context.fs.exists('/bin/nano-wasm')).toBe(true);
        expect(shell.context.fs.exists('/usr/lib/nano/nano.wasm')).toBe(true);

        const rmRes = await run(shell, 'wbt remove nano');
        expect(rmRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/bin/nano')).toBe(false);
        expect(shell.context.fs.exists('/bin/nano-wasm')).toBe(false);
        expect(shell.context.fs.exists('/usr/lib/nano/nano.wasm')).toBe(false);
    });

    it('runs nano even when invoked with readonlyContext without context.fs', async () => {
        await run(shell, 'wbt install nano');
        const NanoCmd = shell._resolveCommandFromPath('/bin/nano');
        expect(NanoCmd).toBeDefined();

        const readonlyCtx = Object.freeze({
            getVar: (k) => shell.context.getVar(k),
            getAlias: (k) => shell.context.getAlias(k),
            getCommand: (k) => shell.context.getCommand(k)
        });
        const instance = new NanoCmd(['--version'], readonlyCtx);
        instance.fs = shell.context.fs.sandbox();
        const res = await instance.runCommand();
        expect(res.getExitCode()).toBe(0);
        expect(res.getStdOutput().map(l => l.string).join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);
    });

    it('runs nano interactively, accepts text input, writes out file, and exits cleanly', async () => {
        if (!NANO_WASM_BYTES) return;
        await run(shell, 'wbt install nano');

        const stdoutChunks = [];
        const onData = (chunk) => stdoutChunks.push(chunk);
        shell.stdout.on('data', onData);

        const cmdPromise = shell.onCommand('nano /test.txt');

        // Allow nano to initialize, query terminal size, enter alt-screen, and render initial UI
        await new Promise(r => setTimeout(r, 60));

        // Type text into nano
        for (const ch of 'Hello from nano!') {
            shell.onInput(ch);
        }
        await new Promise(r => setTimeout(r, 30));

        // Save file: Ctrl+O, then Enter to confirm filename
        shell.onInput('^O');
        await new Promise(r => setTimeout(r, 30));
        shell.onInput('Enter');
        await new Promise(r => setTimeout(r, 30));

        // Exit nano: Ctrl+X
        shell.onInput('^X');

        await cmdPromise;
        shell.stdout.off('data', onData);

        const saved = shell.context.fs.getFileByPath('/test.txt');
        const joinedOutput = stdoutChunks.join('');

        expect(shell.lastCode).toBe(0);
        expect(saved).toContain('Hello from nano!');
        expect(joinedOutput).toContain('\x1b[?1049h'); // entered alt screen
        expect(joinedOutput).toContain('\x1b[?1049l'); // exited alt screen
    });

    it('runs nano interactively via stream write (as in Terminal emulator) and does not duplicate characters', async () => {
        if (!NANO_WASM_BYTES) return;
        await run(shell, 'wbt install nano');

        const stdoutChunks = [];
        const onData = (chunk) => stdoutChunks.push(chunk);
        shell.stdout.on('data', onData);

        const cmdPromise = shell.onCommand('nano /stream-test.txt');

        // Allow nano to initialize, query terminal size, enter alt-screen, and render initial UI
        await new Promise(r => setTimeout(r, 60));

        // Type text into nano via stream write (simulating terminal emulator input)
        for (const ch of 'Hello from stream!') {
            shell.write(ch);
            await new Promise(r => setTimeout(r, 5));
        }
        await new Promise(r => setTimeout(r, 30));

        // Save file: Ctrl+O (\x0f), then Enter (\r) to confirm filename
        shell.write('\x0f');
        await new Promise(r => setTimeout(r, 30));
        shell.write('\r');
        await new Promise(r => setTimeout(r, 30));

        // Exit nano: Ctrl+X (\x18)
        shell.write('\x18');

        await cmdPromise;
        shell.stdout.off('data', onData);

        const saved = shell.context.fs.getFileByPath('/stream-test.txt');

        expect(shell.lastCode).toBe(0);
        expect(saved).toContain('Hello from stream!');
        expect(saved).not.toContain('HHeelllloo');
    });
});

describe('WBT filesystem installer architecture (installer, not runtime)', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({ filesystem: { home: {} } });
        shell.context.setCommand(createTestWbt());
    });

    it('installs pure WASM to /usr/lib/<pkg>/<bin>.wasm and symlinks into /bin/<cmd>', async () => {
        const installRes = await run(shell, 'wbt install nano');
        expect(installRes.exitCode).toBe(0);

        // Binary placed in /usr/lib/nano/nano.wasm
        expect(shell.context.fs.exists('/usr/lib/nano/nano.wasm')).toBe(true);
        expect(shell.context.fs.isExecutable('/usr/lib/nano/nano.wasm')).toBe(true);

        // Symlinks in /bin
        expect(shell.context.fs.isSymlink('/bin/nano')).toBe(true);
        expect(shell.context.fs.readSymlink('/bin/nano')).toBe('/usr/lib/nano/nano.wasm');
        expect(shell.context.fs.isSymlink('/bin/nano-wasm')).toBe(true);
        expect(shell.context.fs.readSymlink('/bin/nano-wasm')).toBe('/usr/lib/nano/nano.wasm');

        // Verify /var/lib/wbt is not created
        expect(shell.context.fs.exists('/var/lib/wbt')).toBe(false);
    });

    it('runs WASM command directly from /bin without wbt registered in context', async () => {
        await run(shell, 'wbt install nano');

        // Persist filesystem as BRFS binary container (the official format for brsh persistence)
        const containerBytes = shell.context.fs.toBinaryContainer();

        // Create a completely fresh shell with the restored filesystem and NO wbt command registered
        const cleanShell = await createShell({
            filesystem: containerBytes
        });
        if (cleanShell.context.fs.exists('/bin/wbt')) {
            cleanShell.context.fs.deleteFileByPath('/bin/wbt');
        }

        // Verify wbt is NOT in cleanShell
        expect(cleanShell.context.getCommand('wbt')).toBeNull();

        // Invoking bare command 'nano --version' runs WASM directly through Shell & WasmCommand
        const res = await run(cleanShell, 'nano --version');
        expect(res.exitCode).toBe(0);
        expect(res.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);

        // Invoking via full path '/bin/nano --version' also runs WASM directly
        const binRes = await run(cleanShell, '/bin/nano --version');
        expect(binRes.exitCode).toBe(0);
        expect(binRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);

        // Invoking via alias 'nano-wasm --version' also runs WASM directly
        const aliasRes = await run(cleanShell, 'nano-wasm --version');
        expect(aliasRes.exitCode).toBe(0);
        expect(aliasRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);
    });

    it('auto-wires sibling JS and WASM in /usr/lib/<pkg>/ without wbt runtime', async () => {
        const dummyWasmBytes = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
            0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
            0x03, 0x02, 0x01, 0x00,
            0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
            0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b
        ]);

        const jsCode = `
            module.exports = async function(Module) {
                return {
                    exec: async function(args) {
                        return 0;
                    }
                };
            };
        `;

        // Co-locate .wasm and .js in /usr/lib/mytool/
        const WasmCmd = shell.constructor.WasmCommand;
        WasmCmd.writeBytesToFs(shell.context.fs, '/usr/lib/mytool/mytool.wasm', dummyWasmBytes);
        shell.context.fs.setFileByPath('/usr/lib/mytool/mytool.js', jsCode, true);
        shell.context.fs.setMode('/usr/lib/mytool/mytool.wasm', 0o755);
        shell.context.fs.setMode('/usr/lib/mytool/mytool.js', 0o755);

        // Create symlink /bin/mytool -> /usr/lib/mytool/mytool.js
        shell.context.fs.createSymlink('/usr/lib/mytool/mytool.js', '/bin/mytool');
        shell.context.fs.setMode('/bin/mytool', 0o755);

        const execRes = await run(shell, 'mytool hello world');
        expect(execRes.exitCode).toBe(0);
    });

    it('registers doom package with aliases doom-wasm, doom-ascii, and freedoom launcher script', async () => {
        const BaseWbt = createTestWbt();
        const registry = BaseWbt.DEFAULT_REGISTRY;
        expect(registry.doom).toBeDefined();
        expect(registry.doom.bin).toBe('doom');
        expect(registry.doom.aliases).toContain('doom-wasm');
        expect(registry.doom.aliases).toContain('doom-ascii');
        expect(registry.doom.scripts).toBeDefined();
        expect(registry.doom.scripts.freedoom).toContain('/bin/freedoom');
        expect(registry.doom.type).toBe('custom-wasm');

        // Test search by script name 'freedoom'
        const searchRes = await run(shell, 'wbt search freedoom');
        expect(searchRes.exitCode).toBe(0);
        expect(searchRes.output.join('\n')).toContain('doom/wasm');

        // Test show
        const showRes = await run(shell, 'wbt show freedoom');
        expect(showRes.exitCode).toBe(0);
        expect(showRes.output.join('\n')).toContain('Package: doom');
        expect(showRes.output.join('\n')).toContain('Aliases: doom-wasm, doom-ascii');
        expect(showRes.output.join('\n')).toContain('Scripts: freedoom');
        expect(showRes.output.join('\n')).toContain('doom.wasm');
    });

    it('installs freedoom launcher script alongside doom, auto-downloads freedoom1.wad if missing, and reuses cached WAD on second run', async () => {
        // Ephemeral wbt run freedoom --help works even before installing doom
        const ephemeralHelp = await run(shell, 'wbt run freedoom --help');
        expect(ephemeralHelp.exitCode).toBe(0);
        expect(ephemeralHelp.output.join('\n')).toContain('Usage: freedoom');
        expect(shell.context.fs.exists('/bin/freedoom')).toBe(false);

        const installRes = await run(shell, 'wbt install doom');
        expect(installRes.exitCode).toBe(0);

        expect(shell.context.fs.exists('/usr/lib/doom/doom.wasm')).toBe(true);
        expect(shell.context.fs.exists('/usr/lib/doom/freedoom')).toBe(true);
        expect(shell.context.fs.isSymlink('/bin/doom')).toBe(true);
        expect(shell.context.fs.isSymlink('/bin/freedoom')).toBe(true);
        expect(shell.context.fs.readSymlink('/bin/freedoom')).toBe('/usr/lib/doom/freedoom');

        // Help works without fetching WAD
        const helpRes = await run(shell, 'freedoom --help');
        expect(helpRes.exitCode).toBe(0);
        expect(helpRes.output.join('\n')).toContain('Usage: freedoom');
        expect(shell.context.fs.exists('/usr/share/games/doom/freedoom1.wad')).toBe(false);

        // Mock global fetch for curl WAD download
        const origFetch = globalThis.fetch;
        let wad1FetchCount = 0;
        let wad2FetchCount = 0;
        const fakeWadBytes = new Uint8Array([0x49, 0x57, 0x41, 0x44, 0x00, 0x00, 0x00, 0x00]); // "IWAD\0\0\0\0"
        globalThis.fetch = async (url) => {
            if (String(url).includes('freedoom1.wad')) {
                wad1FetchCount++;
                return new Response(fakeWadBytes, {
                    status: 200,
                    headers: { 'content-type': 'application/octet-stream', 'content-length': String(fakeWadBytes.length) }
                });
            }
            if (String(url).includes('freedoom2.wad')) {
                wad2FetchCount++;
                return new Response(fakeWadBytes, {
                    status: 200,
                    headers: { 'content-type': 'application/octet-stream', 'content-length': String(fakeWadBytes.length) }
                });
            }
            return origFetch(url);
        };

        try {
            // First run: downloads freedoom1.wad to /usr/share/games/doom/freedoom1.wad and runs doom
            const run1 = await run(shell, 'freedoom');
            expect(run1.exitCode).toBe(0);
            expect(wad1FetchCount).toBe(1);
            expect(shell.context.fs.exists('/usr/share/games/doom/freedoom1.wad')).toBe(true);

            // Second run: WAD already exists at /usr/share/games/doom/freedoom1.wad -> skips download!
            const run2 = await run(shell, 'freedoom');
            expect(run2.exitCode).toBe(0);
            expect(wad1FetchCount).toBe(1);

            // Phase 2: downloads freedoom2.wad to /usr/share/games/doom/freedoom2.wad
            const runPhase2 = await run(shell, 'freedoom --phase2');
            expect(runPhase2.exitCode).toBe(0);
            expect(wad2FetchCount).toBe(1);
            expect(shell.context.fs.exists('/usr/share/games/doom/freedoom2.wad')).toBe(true);
        } finally {
            globalThis.fetch = origFetch;
        }

        // Removing doom removes /bin/freedoom and /usr/lib/doom/freedoom cleanly
        const rmRes = await run(shell, 'wbt remove doom');
        expect(rmRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/bin/freedoom')).toBe(false);
        expect(shell.context.fs.isSymlink('/bin/freedoom')).toBe(false);
        expect(shell.context.fs.exists('/usr/lib/doom/freedoom')).toBe(false);
    });

    it('forwards interactive TTY input and raw ANSI stdout cleanly when an interactive WASM binary is launched inside a shell script', async () => {
        await run(shell, 'wbt install nano');

        // Create a wrapper shell script similar to freedoom
        shell.context.fs._setFileRaw('/bin/edit-note', '#!/bin/sh\nnano /home/script-note.txt\n', true);
        shell.context.fs.setMode('/bin/edit-note', 0o755);

        const rawChunks = [];
        const onData = (chunk) => rawChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        shell.stdout.on('data', onData);

        const cmdPromise = shell.onCommand('edit-note');
        await new Promise(r => setTimeout(r, 120));

        for (const ch of 'Via wrapper!') {
            shell.write(ch);
            await new Promise(r => setTimeout(r, 8));
        }
        await new Promise(r => setTimeout(r, 30));

        // Save: Ctrl+O, Enter, Exit: Ctrl+X
        shell.write('\x0f');
        await new Promise(r => setTimeout(r, 30));
        shell.write('\r');
        await new Promise(r => setTimeout(r, 30));
        shell.write('\x18');

        await cmdPromise;
        shell.stdout.off('data', onData);

        expect(shell.lastCode).toBe(0);
        expect(rawChunks.join('')).toContain('\x1b[?1049h');
        const saved = shell.context.fs.getFileByPath('/home/script-note.txt');
        expect(saved).toContain('Via wrapper!');
    });

    it('Wbt.restoreInstalled is a safe no-op on already-restored filesystems', async () => {
        await run(shell, 'wbt install nano');
        expect(shell.context.fs.isSymlink('/bin/nano')).toBe(true);

        const BaseWbt = createTestWbt();
        BaseWbt.restoreInstalled(shell);

        // /bin/nano remains a symlink to /usr/lib/nano/nano.wasm
        expect(shell.context.fs.isSymlink('/bin/nano')).toBe(true);
        expect(shell.context.fs.readSymlink('/bin/nano')).toBe('/usr/lib/nano/nano.wasm');
    });

    it('cleans up temporary files in /tmp after wbt run', async () => {
        const runRes = await run(shell, 'wbt run nano --version');
        expect(runRes.exitCode).toBe(0);
        expect(runRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);

        // Not installed permanently
        expect(shell.context.fs.exists('/bin/nano')).toBe(false);

        // Check that /tmp does not contain lingering .wbt-run- directories
        const tmpDir = shell.context.fs.getFileByPath('/tmp') || {};
        const tmpKeys = Object.keys(tmpDir);
        expect(tmpKeys.some(k => k.startsWith('.wbt-run-'))).toBe(false);
    });

    it('persists interactive: true in /usr/lib/<pkg>/package.json so standalone WasmCommand detects interactivity immediately', async () => {
        await run(shell, 'wbt install nano');
        await run(shell, 'wbt install doom');

        const nanoPkgJson = JSON.parse(shell.context.fs.getFileByPath('/usr/lib/nano/package.json'));
        const doomPkgJson = JSON.parse(shell.context.fs.getFileByPath('/usr/lib/doom/package.json'));
        expect(nanoPkgJson.interactive).toBe(true);
        expect(doomPkgJson.interactive).toBe(true);

        const WasmCommand = shell.constructor.WasmCommand;
        const doomCmd = new WasmCommand('/usr/lib/doom/doom.wasm', [], shell.context);
        expect(doomCmd.interactive).toBe(true);
        expect(doomCmd.captureInput).toBe(true);
    });

    it('does not duplicate stdin keystrokes and forwards live stdout resizes during wbt run', async () => {
        if (!NANO_WASM_BYTES) return;
        shell.setTerminalSize(110, 36);

        const cmdPromise = shell.onCommand('wbt run nano /wbt-run-note.txt');
        await new Promise(r => setTimeout(r, 80));

        // Resize terminal mid-run -> forwarded to ephemeral wbt run subcommand without error
        shell.setTerminalSize(124, 40);
        await new Promise(r => setTimeout(r, 20));

        for (const ch of 'Single echo!') {
            shell.write(ch);
            await new Promise(r => setTimeout(r, 6));
        }
        await new Promise(r => setTimeout(r, 30));

        // Save: Ctrl+O, Enter, Exit: Ctrl+X
        shell.write('\x0f');
        await new Promise(r => setTimeout(r, 30));
        shell.write('\r');
        await new Promise(r => setTimeout(r, 30));
        shell.write('\x18');

        await cmdPromise;
        expect(shell.lastCode).toBe(0);
        const saved = shell.context.fs.getFileByPath('/wbt-run-note.txt');
        expect(saved).toContain('Single echo!');
        expect(saved).not.toContain('SSiinnggllee');
    });
});

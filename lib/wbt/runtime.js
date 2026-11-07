'use strict';

const ReplCommand = require('./ReplCommand');
const WasmCommand = require('../WasmCommand');
const {
    formatTable,
    formatPipeList,
    formatCsv,
    readBytesFromFs,
    writeBytesToFs,
    loadModule
} = require('./utils');

// Shared runtime caches across invocations
const wasmByteCache = new Map();
let cachedPyodide = null;
let cachedDuckDb = null;

/**
 * Universal runtime Command builder for WBT (`wbt`).
 *
 * Handles ANY WebAssembly binary or JS/WASM module at runtime without needing
 * a per-package wrapper file:
 * 1. Direct `.wasm` / `.wat` binary (via `pkgMeta.wasmUrl` or raw `Uint8Array` / `ArrayBuffer`) ->
 *    Executes directly via `WasmCommand` with full WASI filesystem (`path_open`, `fd_read`, `fd_write`, etc.).
 * 2. Emscripten modularized CLI (`export default function Module(opts)` with `callMain` & `FS`) ->
 *    Automatically syncs input/output files between `brsh` FS and Emscripten `FS`, wires stdin/stdout/stderr, and calls `callMain(args)`.
 * 3. Standard WASM runtime exports detected automatically by capability (duck-typing):
 *    - JSON processors (`jq.raw` / `jq.json`)
 *    - Media transcoders (`FFmpeg` with `writeFile` / `exec` / `readFile`)
 *    - Graph layout compilers (`Graphviz.load()` -> `.layout()`)
 *    - WAT/WASM toolkits (`parseWat` / `readWasm`)
 *    - Language VMs & analytical engines (`loadPyodide`, `AsyncDuckDB`/`createDuckDB`, `getQuickJS`, `LuaFactory`),
 *      automatically providing `-c`/`-e` evaluation, script file execution, AND interactive REPLs!
 */
function createGenericWasmCommand(pkgMeta, wbtConfig = {}, binNameOverride = null) {
    const binName = (binNameOverride || pkgMeta.bin || pkgMeta.name).toLowerCase();

    class GenericWasmCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.includes('--help') || args.includes('-h')) {
                this.stdOut = `${binName} (${pkgMeta.name} ${pkgMeta.version || 'wasm'}) — ${pkgMeta.description || 'WebAssembly binary'}`;
                this.stdOut = `Usage: ${binName} [options] [args...]`;
                return;
            }

            if (args.includes('--version') || (args.includes('-V') && binName !== 'jq')) {
                this.stdOut = `${binName} ${pkgMeta.version || 'wasm'}`;
                return;
            }

            try {
                // 1. If a direct `.wasm` URL is configured (and no custom moduleLoader overrides it), fetch and run raw WASI binary
                if (pkgMeta.type === 'wasm' && pkgMeta.wasmUrl && !wbtConfig.moduleLoader) {
                    const bytes = await this._fetchWasmBytes(pkgMeta.wasmUrl);
                    await this._runRawWasmBytes(bytes, args);
                    return;
                }

                const cdnUrl = pkgMeta.cdnUrl || pkgMeta.wasmUrl || `https://esm.sh/${pkgMeta.name}`;
                const loaded = await loadModule(pkgMeta.name, cdnUrl, wbtConfig.moduleLoader);
                const target = (loaded && loaded.default !== undefined) ? loaded.default : loaded;

                // 2. Raw WASM binary (Uint8Array or ArrayBuffer)
                if (target instanceof Uint8Array || target instanceof ArrayBuffer) {
                    const bytes = target instanceof Uint8Array ? target : new Uint8Array(target);
                    await this._runRawWasmBytes(bytes, args);
                    return;
                }
                if (target && (target.wasmBytes instanceof Uint8Array || target.wasm instanceof Uint8Array)) {
                    await this._runRawWasmBytes(target.wasmBytes || target.wasm, args);
                    return;
                }

                // 3. Auto-detect known WASM runtime capabilities by duck-typing
                const mod = loaded || target;

                // 3a. jq-style module (`raw(json, filter, flags)` or `json(data, filter)`)
                if (this._isJqModule(target, mod)) {
                    await this._runJqModule(target, mod, args);
                    return;
                }

                // 3b. FFmpeg module (`FFmpeg` class)
                if ((mod && typeof mod.FFmpeg === 'function') || (target && typeof target.FFmpeg === 'function')) {
                    await this._runFfmpegModule(mod.FFmpeg || target.FFmpeg, args);
                    return;
                }

                // 3c. Graphviz module (`Graphviz.load` or `layout`)
                if (this._isGraphvizModule(target, mod)) {
                    await this._runGraphvizModule(target, mod, args);
                    return;
                }

                // 3d. WABT module (`parseWat` / `readWasm`)
                if (this._isWabtModule(target, mod)) {
                    await this._runWabtModule(target, mod, args);
                    return;
                }

                // 3e. Pyodide Python runtime (`loadPyodide`)
                if ((mod && typeof mod.loadPyodide === 'function') || (target && typeof target.loadPyodide === 'function')) {
                    await this._runPyodideModule(mod.loadPyodide ? mod : target, args);
                    return;
                }

                // 3f. DuckDB analytical SQL engine (`AsyncDuckDB`, `createDuckDB`, or `createConnection`)
                if (mod && (typeof mod.AsyncDuckDB === 'function' || typeof mod.createDuckDB === 'function' || typeof mod.createConnection === 'function' || (target && (typeof target.AsyncDuckDB === 'function' || typeof target.createDuckDB === 'function' || typeof target.createConnection === 'function')))) {
                    await this._runDuckDbModule((mod.AsyncDuckDB || mod.createDuckDB || mod.createConnection) ? mod : target, args);
                    return;
                }

                // 3g. QuickJS sandbox (`getQuickJS` / `newQuickJSWASMModule`)
                if (mod && (typeof mod.getQuickJS === 'function' || typeof mod.newQuickJSWASMModule === 'function' || (target && typeof target.getQuickJS === 'function'))) {
                    await this._runQuickJsModule(mod.getQuickJS || mod.newQuickJSWASMModule ? mod : target, args);
                    return;
                }

                // 3h. Lua Wasmoon (`LuaFactory`)
                if ((mod && typeof mod.LuaFactory === 'function') || (target && typeof target.LuaFactory === 'function')) {
                    await this._runLuaModule(mod.LuaFactory || target.LuaFactory, args);
                    return;
                }

                // 4. Generic Emscripten modularized factory or CLI function
                if (typeof target === 'function') {
                    await this._runFunctionOrEmscripten(target, loaded, args);
                    return;
                }

                // 5. Object with `callMain`, `main`, `run`, or `exec`
                if (target && typeof target === 'object') {
                    const entryFn = target.main || target.run || target.callMain || target.exec;
                    if (typeof entryFn === 'function') {
                        await this._invokeCliFunction(entryFn.bind(target), args);
                        return;
                    }
                }

                this.stdErr = `${binName}: unsupported WASM module format for '${pkgMeta.name}'`;
                this.exitCode = 1;
            } catch (err) {
                if (err && typeof err.status === 'number') {
                    this.exitCode = err.status;
                    return;
                }
                this.stdErr = `${binName}: ${err.message || err}`;
                this.exitCode = 1;
            }
        }

        async _fetchWasmBytes(url) {
            if (wasmByteCache.has(url)) return wasmByteCache.get(url);
            const fetchFn = wbtConfig.fetch || (typeof fetch === 'function' ? fetch : null);
            if (!fetchFn) throw new Error('fetch is not available in this environment');
            const res = await fetchFn(url);
            if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'error'} fetching ${url}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            wasmByteCache.set(url, bytes);
            return bytes;
        }

        async _runRawWasmBytes(bytes, args) {
            const wasmCmd = new WasmCommand(binName, args, this.context);
            wasmCmd.script = binName;
            wasmCmd.arguments = args;
            wasmCmd.context = this.context;
            wasmCmd.fs = this.fs;
            if (this.stdin !== undefined) {
                wasmCmd.stdin = this.stdin;
            }
            await wasmCmd._runWasm(bytes);
            for (const line of wasmCmd.result.getStdOutput()) {
                if (line.type === 'out') this.stdOut = line.string;
                else if (line.type === 'err') this.stdErr = line.string;
            }
            this.exitCode = wasmCmd.result.getExitCode();
        }

        // --------------------------------------------------------------------
        // Capability 3a: jq JSON processor
        // --------------------------------------------------------------------
        _isJqModule(target, mod) {
            if (binName === 'jq') return true;
            const obj = target || mod;
            return Boolean(obj && (typeof obj.raw === 'function' || (typeof obj.json === 'function' && pkgMeta.name === 'jq')));
        }

        async _runJqModule(target, mod, args) {
            let rawOutput = false;
            let compactOutput = false;
            let nullInput = false;
            const positional = [];

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-r' || a === '--raw-output') rawOutput = true;
                else if (a === '-c' || a === '--compact-output') compactOutput = true;
                else if (a === '-n' || a === '--null-input') nullInput = true;
                else if (!a.startsWith('-')) positional.push(a);
            }

            const filter = positional.length > 0 ? positional.shift() : '.';
            let jsonInput = '';
            if (nullInput) {
                jsonInput = 'null';
            } else if (positional.length > 0) {
                const chunks = [];
                for (const filePath of positional) {
                    const content = this.fs.getFileByPath(filePath);
                    if (content === null || content === undefined) {
                        this.stdErr = `jq: ${filePath}: No such file or directory`;
                        this.exitCode = 2;
                        return;
                    }
                    chunks.push(String(content));
                }
                jsonInput = chunks.join('\n');
            } else if (this.stdin !== undefined && this.stdin !== null) {
                jsonInput = String(this.stdin);
            } else {
                this.stdErr = 'jq: no JSON input provided via file or stdin';
                this.exitCode = 2;
                return;
            }

            let jq = await Promise.resolve(typeof target === 'function' && !target.raw && !target.json ? target() : (target || mod));
            if (jq && jq.default) jq = await Promise.resolve(jq.default);

            if (jq && typeof jq.raw === 'function') {
                const flags = [];
                if (rawOutput) flags.push('-r');
                if (compactOutput) flags.push('-c');
                if (nullInput) flags.push('-n');
                const out = await jq.raw(jsonInput.trim(), filter, flags);
                if (out !== undefined && out !== null) {
                    String(out).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                }
            } else if (jq && typeof jq.json === 'function') {
                const parsed = JSON.parse(jsonInput.trim());
                const result = await jq.json(parsed, filter);
                if (rawOutput && typeof result === 'string') {
                    result.split(/\r?\n/).forEach(l => { this.stdOut = l; });
                } else {
                    const formatted = compactOutput ? JSON.stringify(result) : JSON.stringify(result, null, 2);
                    if (formatted !== undefined) {
                        formatted.split(/\r?\n/).forEach(l => { this.stdOut = l; });
                    }
                }
            }
        }

        // --------------------------------------------------------------------
        // Capability 3b: FFmpeg media transcoder
        // --------------------------------------------------------------------
        async _runFfmpegModule(FFmpegClass, args) {
            const ffmpeg = new FFmpegClass();
            const logs = [];
            if (typeof ffmpeg.on === 'function') {
                ffmpeg.on('log', ({ message }) => {
                    if (message) logs.push(message);
                });
            }
            if (!ffmpeg.loaded && typeof ffmpeg.load === 'function') {
                await ffmpeg.load(pkgMeta.coreUrl ? { coreURL: pkgMeta.coreUrl } : undefined);
            }

            const existingInputs = new Set();
            const candidatePaths = [];
            for (const arg of args) {
                if (arg.startsWith('-')) continue;
                candidatePaths.push(arg);
                if (this.fs.exists(arg)) {
                    const bytes = readBytesFromFs(this.fs, arg);
                    if (bytes && typeof ffmpeg.writeFile === 'function') {
                        await ffmpeg.writeFile(arg, bytes);
                        existingInputs.add(arg);
                    }
                }
            }

            const code = await ffmpeg.exec(args);
            for (const candidate of candidatePaths) {
                if (existingInputs.has(candidate)) continue;
                try {
                    if (typeof ffmpeg.readFile === 'function') {
                        const outData = await ffmpeg.readFile(candidate);
                        if (outData) writeBytesToFs(this.fs, candidate, outData);
                    }
                } catch { /* ignore */ }
            }

            if (code !== 0 && code !== undefined) {
                logs.forEach(l => { this.stdErr = l; });
                this.exitCode = typeof code === 'number' ? code : 1;
            } else if (args.includes('-version') || logs.length > 0) {
                logs.forEach(l => { this.stdOut = l; });
            }
        }

        // --------------------------------------------------------------------
        // Capability 3c: Graphviz DOT compiler
        // --------------------------------------------------------------------
        _isGraphvizModule(target, mod) {
            return Boolean(
                (mod && mod.Graphviz && typeof mod.Graphviz.load === 'function') ||
                (target && target.Graphviz && typeof target.Graphviz.load === 'function') ||
                (target && typeof target.load === 'function' && (binName === 'dot' || binName === 'graphviz')) ||
                (target && typeof target.layout === 'function')
            );
        }

        async _runGraphvizModule(target, mod, args) {
            let format = 'svg';
            let engine = 'dot';
            let outFile = null;
            const inputFiles = [];

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a.startsWith('-T')) format = a.slice(2) || args[++i] || 'svg';
                else if (a.startsWith('-K')) engine = a.slice(2) || args[++i] || 'dot';
                else if (a === '-o' && i + 1 < args.length) outFile = args[++i];
                else if (a.startsWith('-o') && a.length > 2) outFile = a.slice(2);
                else if (!a.startsWith('-')) inputFiles.push(a);
            }

            let dotSource = '';
            if (inputFiles.length > 0) {
                const content = this.fs.getFileByPath(inputFiles[0]);
                if (content === null || content === undefined) {
                    this.stdErr = `${binName}: ${inputFiles[0]}: No such file or directory`;
                    this.exitCode = 1;
                    return;
                }
                dotSource = String(content);
            } else if (this.stdin) {
                dotSource = String(this.stdin);
            } else {
                this.stdErr = `${binName}: no input DOT graph provided`;
                this.exitCode = 1;
                return;
            }

            const Graphviz = (mod && mod.Graphviz) || (target && target.Graphviz) || target;
            const gv = typeof Graphviz.load === 'function' ? await Graphviz.load() : Graphviz;
            const rendered = typeof gv.layout === 'function'
                ? await gv.layout(dotSource, format, engine)
                : await gv.dot(dotSource, format);

            if (outFile) {
                this.fs.setFileByPath(outFile, String(rendered), true);
            } else {
                String(rendered).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
            }
        }

        // --------------------------------------------------------------------
        // Capability 3d: WABT (wat2wasm / wasm2wat)
        // --------------------------------------------------------------------
        _isWabtModule(target, mod) {
            return Boolean(binName === 'wat2wasm' || binName === 'wasm2wat' || (target && typeof target.parseWat === 'function'));
        }

        async _runWabtModule(target, mod, args) {
            let outFile = null;
            const positional = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if ((a === '-o' || a === '--output') && i + 1 < args.length) outFile = args[++i];
                else if (!a.startsWith('-')) positional.push(a);
            }

            const inputFile = positional[0];
            if (!inputFile) {
                this.stdErr = `${binName}: no input file specified`;
                this.exitCode = 1;
                return;
            }

            const factory = typeof target === 'function' ? target : (mod && mod.default);
            const wabt = typeof factory === 'function' ? await factory() : (target || mod);

            if (binName === 'wat2wasm') {
                const watSource = this.fs.getFileByPath(inputFile);
                if (watSource === null || watSource === undefined) {
                    this.stdErr = `wat2wasm: ${inputFile}: No such file or directory`;
                    this.exitCode = 1;
                    return;
                }
                const parsed = wabt.parseWat(inputFile, String(watSource));
                const { buffer } = parsed.toBinary({ log: false, write_debug_names: true });
                const targetPath = outFile || inputFile.replace(/\.wat$/, '.wasm');
                writeBytesToFs(this.fs, targetPath, new Uint8Array(buffer), 'application/wasm');
                if (this.context && this.context.fs && typeof this.context.fs.setMode === 'function') {
                    this.context.fs.setMode(targetPath, 0o755);
                }
            } else {
                const bytes = readBytesFromFs(this.fs, inputFile);
                if (!bytes) {
                    this.stdErr = `wasm2wat: ${inputFile}: No such file or directory`;
                    this.exitCode = 1;
                    return;
                }
                const parsed = wabt.readWasm(bytes, { readDebugNames: true });
                const watText = parsed.toText({ foldExprs: false, inlineExport: false });
                if (outFile) {
                    this.fs.setFileByPath(outFile, watText, true);
                } else {
                    watText.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                }
            }
        }

        // --------------------------------------------------------------------
        // Capability 3e: Pyodide (Python 3)
        // --------------------------------------------------------------------
        async _runPyodideModule(mod, args) {
            let evalCode = null;
            let scriptFile = null;
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-c' && i + 1 < args.length) {
                    evalCode = args[++i];
                    break;
                } else if (!a.startsWith('-') && !scriptFile) {
                    scriptFile = a;
                    break;
                }
            }

            if (evalCode === null && !scriptFile && this.stdin && String(this.stdin).trim()) {
                evalCode = String(this.stdin);
            }

            const loadPyodide = mod.loadPyodide || mod;
            const pyodide = (!cachedPyodide || wbtConfig.moduleLoader)
                ? await loadPyodide({ indexURL: pkgMeta.indexURL })
                : cachedPyodide;
            if (!wbtConfig.moduleLoader) cachedPyodide = pyodide;

            const runPy = async (code) => {
                const outLines = [];
                const errLines = [];
                if (typeof pyodide.setStdout === 'function') pyodide.setStdout({ batched: (s) => outLines.push(s) });
                if (typeof pyodide.setStderr === 'function') pyodide.setStderr({ batched: (s) => errLines.push(s) });
                if (pyodide.FS && typeof pyodide.FS.writeFile === 'function') {
                    this._syncBrshToEmscriptenFs(pyodide.FS, args);
                }
                const result = await pyodide.runPythonAsync(code);
                return { result, outLines, errLines };
            };

            if (evalCode !== null || scriptFile) {
                let codeToRun = evalCode;
                if (scriptFile) {
                    const content = this.fs.getFileByPath(scriptFile);
                    if (content === null || content === undefined) {
                        this.stdErr = `${binName}: can't open file '${scriptFile}': [Errno 2] No such file or directory`;
                        this.exitCode = 2;
                        return;
                    }
                    codeToRun = String(content);
                }
                const { result, outLines, errLines } = await runPy(codeToRun);
                outLines.forEach(l => { this.stdOut = l; });
                errLines.forEach(l => { this.stdErr = l; });
                if (evalCode !== null && outLines.length === 0 && result !== undefined && result !== null) {
                    this.stdOut = String(result);
                }
                return;
            }

            return this.startRepl({
                banner: [
                    `Python ${pkgMeta.version || '3.12.1'} (Pyodide/WASM) on brsh`,
                    'Type "exit()" or Ctrl+D to exit.'
                ],
                prompt: '>>> ',
                isExitCommand: (line) => ['exit()', 'quit()', '.exit'].includes(line),
                onEvaluate: async (line) => {
                    const { result, outLines, errLines } = await runPy(line);
                    const lines = [...outLines, ...errLines];
                    if (lines.length === 0 && result !== undefined && result !== null) {
                        lines.push(String(result));
                    }
                    return lines;
                }
            });
        }

        // --------------------------------------------------------------------
        // Capability 3f: DuckDB analytical SQL engine
        // --------------------------------------------------------------------
        async _runDuckDbModule(mod, args) {
            let outputMode = 'table';
            const queries = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-csv' || a === '--csv') outputMode = 'csv';
                else if (a === '-list' || a === '--list') outputMode = 'list';
                else if (a === '-json' || a === '--json') outputMode = 'json';
                else if (a === '-table' || a === '--table' || a === '-box') outputMode = 'table';
                else if ((a === '-c' || a === '-s') && i + 1 < args.length) queries.push(args[++i]);
                else if (!a.startsWith('-') && !a.endsWith('.duckdb') && !a.endsWith('.db')) queries.push(a);
            }

            if (queries.length === 0 && this.stdin && String(this.stdin).trim()) {
                queries.push(String(this.stdin).trim());
            }

            let conn;
            if (typeof mod.createConnection === 'function') {
                conn = await mod.createConnection();
            } else if (typeof mod.connect === 'function') {
                conn = await mod.connect();
            } else if (typeof mod.createDuckDB === 'function') {
                const db = await mod.createDuckDB();
                conn = await db.connect();
            } else {
                if (!cachedDuckDb || wbtConfig.moduleLoader) {
                    const bundles = mod.getJsDelivrBundles ? mod.getJsDelivrBundles() : {};
                    const bundle = mod.selectBundle ? await mod.selectBundle(bundles) : {};
                    const worker = bundle.mainWorker ? await mod.createWorker(bundle.mainWorker) : null;
                    const logger = mod.ConsoleLogger ? new mod.ConsoleLogger() : undefined;
                    const db = new mod.AsyncDuckDB(logger, worker);
                    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
                    cachedDuckDb = db;
                }
                conn = await cachedDuckDb.connect();
            }

            const execSql = async (sql) => {
                const res = await conn.query(sql);
                let columns = [];
                let rows = [];
                if (res && typeof res.toArray === 'function') {
                    const objs = res.toArray().map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r));
                    if (objs.length > 0) {
                        columns = Object.keys(objs[0]);
                        rows = objs.map(o => columns.map(c => o[c]));
                    }
                } else if (res && Array.isArray(res.columns) && Array.isArray(res.rows)) {
                    columns = res.columns;
                    rows = res.rows;
                }
                if (columns.length === 0) return [];
                if (outputMode === 'csv') return formatCsv(columns, rows);
                if (outputMode === 'list') return formatPipeList(columns, rows, false);
                if (outputMode === 'json') {
                    const objs = rows.map(r => Object.fromEntries(columns.map((c, idx) => [c, r[idx]])));
                    return JSON.stringify(objs, null, 2).split('\n');
                }
                return formatTable(columns, rows);
            };

            if (queries.length > 0) {
                for (const q of queries) {
                    const lines = await execSql(q);
                    lines.forEach(l => { this.stdOut = l; });
                }
                return;
            }

            return this.startRepl({
                banner: [
                    `DuckDB ${pkgMeta.version || '1.29.0'} (WebAssembly) on brsh`,
                    'Enter ".exit" or Ctrl+D to exit.'
                ],
                prompt: 'D ',
                continuePrompt: '  > ',
                needsMoreInput: (buf) => {
                    const t = buf.trim();
                    return Boolean(t && !t.startsWith('.') && !t.endsWith(';'));
                },
                onEvaluate: execSql
            });
        }

        // --------------------------------------------------------------------
        // Capability 3g & 3h: QuickJS & Lua VMs
        // --------------------------------------------------------------------
        async _runQuickJsModule(mod, args) {
            let evalCode = null;
            let scriptFile = null;
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if ((a === '-e' || a === '--eval') && i + 1 < args.length) evalCode = args[++i];
                else if (!a.startsWith('-')) scriptFile = a;
            }
            if (evalCode === null && !scriptFile && this.stdin && String(this.stdin).trim()) {
                evalCode = String(this.stdin);
            }

            const getQuickJS = mod.getQuickJS || mod.newQuickJSWASMModule || mod;
            const QuickJS = await getQuickJS();

            const evalInVm = (code, filename = 'eval.js') => {
                const vm = QuickJS.newContext ? QuickJS.newContext() : QuickJS;
                const out = [];
                try {
                    const res = vm.evalCode(code, filename);
                    if (res && typeof res === 'object' && ('value' in res || 'error' in res)) {
                        if (res.error) {
                            const dumped = vm.dump ? vm.dump(res.error) : res.error;
                            if (res.error.dispose) res.error.dispose();
                            throw new Error(typeof dumped === 'object' && dumped !== null ? (dumped.message || JSON.stringify(dumped)) : String(dumped));
                        }
                        const val = vm.dump ? vm.dump(res.value) : res.value;
                        if (res.value && res.value.dispose) res.value.dispose();
                        if (val !== undefined) out.push(typeof val === 'object' ? JSON.stringify(val) : String(val));
                    } else if (res !== undefined) {
                        out.push(typeof res === 'object' ? JSON.stringify(res) : String(res));
                    }
                } finally {
                    if (vm.dispose) vm.dispose();
                }
                return out;
            };

            if (evalCode !== null || scriptFile) {
                const code = scriptFile ? this.fs.getFileByPath(scriptFile) : evalCode;
                if (scriptFile && (code === null || code === undefined)) {
                    this.stdErr = `${binName}: cannot load '${scriptFile}': No such file or directory`;
                    this.exitCode = 1;
                    return;
                }
                evalInVm(String(code), scriptFile || 'cmdline.js').forEach(l => { this.stdOut = l; });
                return;
            }

            return this.startRepl({
                banner: [`QuickJS (WebAssembly) — Type ".exit" or Ctrl+D to quit.`],
                prompt: 'qjs > ',
                onEvaluate: async (line) => evalInVm(line, 'repl.js')
            });
        }

        async _runLuaModule(LuaFactory, args) {
            let evalCode = null;
            let scriptFile = null;
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-e' && i + 1 < args.length) evalCode = args[++i];
                else if (!a.startsWith('-')) scriptFile = a;
            }
            if (evalCode === null && !scriptFile && this.stdin && String(this.stdin).trim()) {
                evalCode = String(this.stdin);
            }

            const factory = new LuaFactory();
            const lua = await factory.createEngine();

            if (evalCode !== null || scriptFile) {
                try {
                    const code = scriptFile ? this.fs.getFileByPath(scriptFile) : evalCode;
                    if (scriptFile && (code === null || code === undefined)) {
                        this.stdErr = `lua: cannot open ${scriptFile}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    const res = await lua.doString(String(code));
                    if (res !== undefined && res !== null) this.stdOut = String(res);
                } finally {
                    if (lua.global && typeof lua.global.close === 'function') lua.global.close();
                }
                return;
            }

            return this.startRepl({
                banner: [`Lua ${pkgMeta.version || '5.4.6'} (WebAssembly) — Type ".exit" or Ctrl+D to quit.`],
                prompt: 'lua> ',
                onEvaluate: async (line) => {
                    const res = await lua.doString(line);
                    return res !== undefined && res !== null ? [String(res)] : [];
                },
                onClose: () => {
                    if (lua.global && typeof lua.global.close === 'function') lua.global.close();
                }
            });
        }

        // --------------------------------------------------------------------
        // Capability 4 & 5: Generic Emscripten / CLI functions
        // --------------------------------------------------------------------
        async _runFunctionOrEmscripten(fn, fullModule, args) {
            const outLines = [];
            const errLines = [];
            const stdinBytes = new TextEncoder().encode(this.stdin || '');
            let stdinPos = 0;

            let preSyncedFiles = new Set();
            const emscriptenConfig = {
                arguments: args,
                noInitialRun: true,
                print: (text) => { outLines.push(String(text)); },
                printErr: (text) => { errLines.push(String(text)); },
                stdin: () => (stdinPos < stdinBytes.length ? stdinBytes[stdinPos++] : null),
                preRun: [
                    (mod) => {
                        if (mod && mod.FS) {
                            preSyncedFiles = this._syncBrshToEmscriptenFs(mod.FS, args);
                        }
                    }
                ]
            };

            const ioContext = {
                args,
                stdin: this.stdin || '',
                fs: this.fs,
                context: this.context,
                stdout: (line) => outLines.push(String(line)),
                stderr: (line) => errLines.push(String(line))
            };

            let result;
            try {
                result = await fn(emscriptenConfig, ioContext);
            } catch (err) {
                if (err && typeof err.status === 'number') {
                    this.exitCode = err.status;
                } else {
                    throw err;
                }
            }

            if (result && typeof result === 'object' && typeof result.callMain === 'function') {
                if (result.FS && preSyncedFiles.size === 0) {
                    preSyncedFiles = this._syncBrshToEmscriptenFs(result.FS, args);
                }
                try {
                    const code = await result.callMain(args);
                    if (typeof code === 'number' && code !== 0) {
                        this.exitCode = code;
                    }
                } catch (err) {
                    if (err && typeof err.status === 'number') {
                        this.exitCode = err.status;
                    } else {
                        errLines.push(err.message || String(err));
                        this.exitCode = 1;
                    }
                }
                if (result.FS) {
                    this._syncEmscriptenFsToBrsh(result.FS, args, preSyncedFiles);
                }
            } else if (typeof result === 'string') {
                result.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
            } else if (result && typeof result === 'object') {
                if (typeof result.stdout === 'string' && result.stdout) {
                    result.stdout.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
                }
                if (typeof result.stderr === 'string' && result.stderr) {
                    result.stderr.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => errLines.push(l));
                }
                if (typeof result.exitCode === 'number') {
                    this.exitCode = result.exitCode;
                }
            }

            outLines.forEach(l => { this.stdOut = l; });
            errLines.forEach(l => { this.stdErr = l; });
        }

        async _invokeCliFunction(fn, args) {
            const outLines = [];
            const errLines = [];
            const res = await fn(args, {
                stdin: this.stdin || '',
                fs: this.fs,
                stdout: (l) => outLines.push(String(l)),
                stderr: (l) => errLines.push(String(l))
            });
            if (typeof res === 'string') {
                res.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
            } else if (typeof res === 'number') {
                this.exitCode = res;
            }
            outLines.forEach(l => { this.stdOut = l; });
            errLines.forEach(l => { this.stdErr = l; });
        }

        _syncBrshToEmscriptenFs(emFs, args) {
            const synced = new Set();
            if (!this.fs || !emFs || typeof emFs.writeFile !== 'function') return synced;
            for (const arg of args) {
                if (arg.startsWith('-')) continue;
                if (this.fs.exists(arg)) {
                    const bytes = readBytesFromFs(this.fs, arg);
                    if (bytes) {
                        try {
                            emFs.writeFile(arg, bytes);
                            synced.add(arg);
                        } catch { /* ignore */ }
                    }
                }
            }
            return synced;
        }

        _syncEmscriptenFsToBrsh(emFs, args, preSyncedFiles) {
            if (!this.fs || !emFs || typeof emFs.readFile !== 'function') return;
            for (const arg of args) {
                if (arg.startsWith('-') || preSyncedFiles.has(arg)) continue;
                try {
                    const data = emFs.readFile(arg);
                    if (data) {
                        writeBytesToFs(this.fs, arg, data);
                    }
                } catch {
                    // Not an output file in Emscripten FS
                }
            }
        }
    }

    return GenericWasmCommand;
}

module.exports = {
    createGenericWasmCommand
};

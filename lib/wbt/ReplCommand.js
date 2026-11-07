'use strict';

const InteractiveCommand = require('../InteractiveCommand');
const { createGenericWasmCommand } = require('./runtime');
const {
    formatTable,
    formatPipeList,
    formatCsv,
    loadModule
} = require('./utils');

const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const RESET = '\x1b[0m';
const INVERT = '\x1b[7m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

// Shared VM caches for stateful REPL / VM runtimes
let cachedPyodide = null;
let cachedDuckDb = null;

/**
 * Base class for WBT packages that support both:
 * 1. Non-interactive CLI / piped stdin / one-shot flag mode (`runNonInteractive()`)
 * 2. Full-screen interactive REPL mode (`run()`) when invoked with no query/script
 */
class ReplCommand extends InteractiveCommand {
    get requiresFilesystem() {
        return true;
    }

    get interactive() {
        return this.shouldBeInteractive();
    }

    get captureInput() {
        return this.shouldBeInteractive();
    }

    shouldBeInteractive() {
        return Boolean(this._dynamicReplActive);
    }

    getReplTitle() {
        return (this._dynamicReplOpts && this._dynamicReplOpts.title) || `${this.name} interactive shell`;
    }

    getReplPrompt() {
        if (this._dynamicReplMultiline && this._dynamicReplOpts && this._dynamicReplOpts.continuePrompt) {
            return this._dynamicReplOpts.continuePrompt;
        }
        return (this._dynamicReplOpts && this._dynamicReplOpts.prompt) || `${this.name}> `;
    }

    getReplWelcome() {
        return (this._dynamicReplOpts && this._dynamicReplOpts.banner) || [`Welcome to ${this.name}. Type .exit or Ctrl+D to quit.`];
    }

    async initRepl() {}

    async evaluateReplLine(line) {
        if (this._dynamicReplOpts && typeof this._dynamicReplOpts.onEvaluate === 'function') {
            const out = await this._dynamicReplOpts.onEvaluate(line);
            return { output: Array.isArray(out) ? out : (out != null ? [String(out)] : []) };
        }
        return { output: [] };
    }

    async cleanupRepl() {
        if (this._dynamicReplOpts && typeof this._dynamicReplOpts.onClose === 'function') {
            await this._dynamicReplOpts.onClose();
        }
    }

    async runNonInteractive() {}

    /**
     * Dynamically enters interactive REPL mode with the provided options:
     * `{ title, banner, prompt, continuePrompt, needsMoreInput, isExitCommand, onEvaluate, onClose }`
     */
    startRepl(opts = {}) {
        this._dynamicReplActive = true;
        this._dynamicReplOpts = opts;
        this._dynamicReplBuffer = '';
        this._dynamicReplMultiline = false;
        return this._launchInteractiveReplLoop();
    }

    run() {
        if (!this.shouldBeInteractive()) {
            return Promise.resolve(this.runNonInteractive());
        }
        return this._launchInteractiveReplLoop();
    }

    _launchInteractiveReplLoop() {
        this._replHistory = [];
        this._replHistoryIdx = null;
        this._replInput = '';
        this._replCursor = 0;
        this._replLog = [];
        this._replBusy = true;
        this._replStatus = 'Initializing WASM runtime...';
        this._scrollOffset = 0;

        this._renderRepl();

        return new Promise((resolve) => {
            this._replResolve = resolve;
            Promise.resolve()
                .then(() => this.initRepl())
                .then(() => {
                    this._replBusy = false;
                    this._replStatus = '^D / .exit: Quit  |  ^L: Clear  |  Up/Down: History';
                    for (const line of this.getReplWelcome()) {
                        this._appendReplLog(line, 'info');
                    }
                    this._renderRepl();
                })
                .catch((err) => {
                    this._replBusy = false;
                    this.stdErr = err.message || String(err);
                    this.exitCode = 1;
                    this._exitRepl();
                });
        });
    }

    _appendReplLog(text, type = 'out') {
        const lines = String(text ?? '').split(/\r?\n/);
        for (const line of lines) {
            this._replLog.push({ text: line, type });
        }
        this._scrollOffset = 0;
    }

    onInput(key) {
        if (!this.shouldBeInteractive()) return;

        if (key === '^D' || key === '^X') {
            this._exitRepl();
            return;
        }
        if (key === '^C') {
            if (this._replInput.length > 0 || this._dynamicReplBuffer) {
                this._appendReplLog(`${this.getReplPrompt()}${this._replInput}^C`, 'prompt');
                this._replInput = '';
                this._replCursor = 0;
                this._dynamicReplBuffer = '';
                this._dynamicReplMultiline = false;
                this._renderRepl();
            } else {
                this._exitRepl();
            }
            return;
        }

        if (this._replBusy) return;

        if (key === '^L') {
            this._replLog = [];
            this._scrollOffset = 0;
            this._renderRepl();
            return;
        }

        if (key === 'Enter') {
            const line = this._replInput;
            this._replInput = '';
            this._replCursor = 0;
            this._replHistoryIdx = null;
            if (line.trim()) {
                this._replHistory.push(line);
            }
            this._appendReplLog(`${this.getReplPrompt()}${line}`, 'prompt');

            const trimmed = line.trim();
            const customExit = this._dynamicReplOpts && typeof this._dynamicReplOpts.isExitCommand === 'function'
                ? this._dynamicReplOpts.isExitCommand(trimmed)
                : false;
            if (customExit || trimmed === '.exit' || trimmed === '.quit' || trimmed === '\\q' || trimmed === 'exit' || trimmed === 'quit') {
                this._exitRepl();
                return;
            }
            if (trimmed === '.clear' || trimmed === '\\! clear') {
                this._replLog = [];
                this._renderRepl();
                return;
            }

            if (this._dynamicReplOpts && typeof this._dynamicReplOpts.needsMoreInput === 'function') {
                this._dynamicReplBuffer = this._dynamicReplBuffer ? `${this._dynamicReplBuffer}\n${line}` : line;
                if (this._dynamicReplOpts.needsMoreInput(this._dynamicReplBuffer)) {
                    this._dynamicReplMultiline = true;
                    this._renderRepl();
                    return;
                }
            }

            const codeToEval = this._dynamicReplBuffer || line;
            this._dynamicReplBuffer = '';
            this._dynamicReplMultiline = false;

            this._replBusy = true;
            this._replStatus = 'Running...';
            this._renderRepl();

            Promise.resolve()
                .then(() => this.evaluateReplLine(codeToEval))
                .then((res) => {
                    this._replBusy = false;
                    this._replStatus = '^D / .exit: Quit  |  ^L: Clear  |  Up/Down: History';
                    if (res) {
                        if (res.clear) {
                            this._replLog = [];
                        }
                        if (Array.isArray(res.output)) {
                            for (const outLine of res.output) {
                                this._appendReplLog(outLine, 'out');
                            }
                        } else if (typeof res.output === 'string' && res.output.length > 0) {
                            this._appendReplLog(res.output, 'out');
                        }
                        if (res.error) {
                            this._appendReplLog(res.error, 'err');
                        }
                        if (res.exit) {
                            this._exitRepl();
                            return;
                        }
                    }
                    this._renderRepl();
                })
                .catch((err) => {
                    this._replBusy = false;
                    this._replStatus = '^D / .exit: Quit  |  ^L: Clear  |  Up/Down: History';
                    this._appendReplLog(`Error: ${err.message || err}`, 'err');
                    this._renderRepl();
                });
            return;
        }

        if (key === 'Backspace') {
            if (this._replCursor > 0) {
                this._replInput =
                    this._replInput.slice(0, this._replCursor - 1) +
                    this._replInput.slice(this._replCursor);
                this._replCursor--;
                this._renderRepl();
            }
            return;
        }

        if (key === 'Delete') {
            if (this._replCursor < this._replInput.length) {
                this._replInput =
                    this._replInput.slice(0, this._replCursor) +
                    this._replInput.slice(this._replCursor + 1);
                this._renderRepl();
            }
            return;
        }

        if (key === 'ArrowLeft') {
            if (this._replCursor > 0) {
                this._replCursor--;
                this._renderRepl();
            }
            return;
        }

        if (key === 'ArrowRight') {
            if (this._replCursor < this._replInput.length) {
                this._replCursor++;
                this._renderRepl();
            }
            return;
        }

        if (key === 'Home' || key === '^A') {
            this._replCursor = 0;
            this._renderRepl();
            return;
        }

        if (key === 'End' || key === '^E') {
            this._replCursor = this._replInput.length;
            this._renderRepl();
            return;
        }

        if (key === 'ArrowUp') {
            if (this._replHistory.length === 0) return;
            if (this._replHistoryIdx === null) {
                this._replHistoryIdx = this._replHistory.length - 1;
            } else if (this._replHistoryIdx > 0) {
                this._replHistoryIdx--;
            }
            this._replInput = this._replHistory[this._replHistoryIdx];
            this._replCursor = this._replInput.length;
            this._renderRepl();
            return;
        }

        if (key === 'ArrowDown') {
            if (this._replHistoryIdx === null) return;
            if (this._replHistoryIdx < this._replHistory.length - 1) {
                this._replHistoryIdx++;
                this._replInput = this._replHistory[this._replHistoryIdx];
            } else {
                this._replHistoryIdx = null;
                this._replInput = '';
            }
            this._replCursor = this._replInput.length;
            this._renderRepl();
            return;
        }

        if (key === 'PageUp') {
            const maxScroll = Math.max(0, this._replLog.length - 5);
            this._scrollOffset = Math.min(maxScroll, this._scrollOffset + 5);
            this._renderRepl();
            return;
        }

        if (key === 'PageDown') {
            this._scrollOffset = Math.max(0, this._scrollOffset - 5);
            this._renderRepl();
            return;
        }

        if (key.length === 1 && !key.startsWith('^')) {
            this._replInput =
                this._replInput.slice(0, this._replCursor) +
                key +
                this._replInput.slice(this._replCursor);
            this._replCursor++;
            this._renderRepl();
        }
    }

    _renderRepl() {
        const { cols, rows } = this.terminalSize;
        const bodyRows = Math.max(3, rows - 3);

        const title = ` ${this.getReplTitle()} `;
        const headerBar = `${INVERT}${BOLD}${title.padEnd(cols).slice(0, cols)}${RESET}`;

        const totalLog = this._replLog.length;
        const endIdx = Math.max(0, totalLog - this._scrollOffset);
        const startIdx = Math.max(0, endIdx - bodyRows);
        const visibleLog = this._replLog.slice(startIdx, endIdx);

        const renderedBody = [];
        for (let i = 0; i < bodyRows; i++) {
            const entry = visibleLog[i];
            if (!entry) {
                renderedBody.push('');
                continue;
            }
            if (entry.type === 'prompt') {
                renderedBody.push(`${CYAN}${entry.text}${RESET}`);
            } else if (entry.type === 'err') {
                renderedBody.push(`${RED}${entry.text}${RESET}`);
            } else if (entry.type === 'info') {
                renderedBody.push(`${DIM}${entry.text}${RESET}`);
            } else {
                renderedBody.push(entry.text);
            }
        }

        const promptStr = this.getReplPrompt();
        const before = this._replInput.slice(0, this._replCursor);
        const cursorChar = this._replCursor < this._replInput.length ? this._replInput[this._replCursor] : ' ';
        const after = this._replCursor < this._replInput.length ? this._replInput.slice(this._replCursor + 1) : '';
        const inputLine = this._replBusy
            ? `${DIM}${this._replStatus}${RESET}`
            : `${GREEN}${BOLD}${promptStr}${RESET}${before}${INVERT}${cursorChar}${RESET}${after}`;

        const footerText = ` ${this._replStatus} `;
        const footerBar = `${INVERT}${footerText.padEnd(cols).slice(0, cols)}${RESET}`;

        const screen = [
            CLEAR_SCREEN + headerBar,
            ...renderedBody,
            inputLine,
            footerBar
        ].join('\n');

        this.stdOut = screen;
        this.flush();
    }

    _exitRepl() {
        Promise.resolve()
            .then(() => this.cleanupRepl())
            .catch(() => {})
            .finally(() => {
                if (this._replResolve) {
                    const r = this._replResolve;
                    this._replResolve = null;
                    r();
                }
            });
    }
}

/**
 * Extension of `createGenericWasmCommand` for WBT packages that support an interactive REPL
 * (`python3`, `duckdb`, `quickjs`, `lua`, or any package with `repl: true` in `registry.js`).
 *
 * Inherits all base WASM & Emscripten capabilities from `createGenericWasmCommand`, and adds
 * stateful REPL session evaluation via `ReplCommand`.
 */
function createReplWasmCommand(pkgMeta, wbtConfig = {}, binNameOverride = null) {
    const binName = (binNameOverride || pkgMeta.bin || pkgMeta.name).toLowerCase();
    const BaseWasmCmd = createGenericWasmCommand(pkgMeta, wbtConfig, binName);

    class ReplWasmCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-V')) {
                return this._delegateToBaseWasm(args);
            }

            try {
                const cdnUrl = pkgMeta.cdnUrl || pkgMeta.wasmUrl || `https://esm.sh/${pkgMeta.name}`;
                const loaded = await loadModule(pkgMeta.name, cdnUrl, wbtConfig.moduleLoader);
                const target = (loaded && loaded.default !== undefined) ? loaded.default : loaded;
                const mod = loaded || target;

                // 1. Pyodide Python VM (`loadPyodide`)
                if ((mod && typeof mod.loadPyodide === 'function') || (target && typeof target.loadPyodide === 'function')) {
                    return await this._runPyodideReplOrCli(mod.loadPyodide ? mod : target, args);
                }

                // 2. DuckDB analytical SQL engine (`AsyncDuckDB`, `createDuckDB`, `createConnection`)
                if (mod && (typeof mod.AsyncDuckDB === 'function' || typeof mod.createDuckDB === 'function' || typeof mod.createConnection === 'function' || (target && (typeof target.AsyncDuckDB === 'function' || typeof target.createDuckDB === 'function' || typeof target.createConnection === 'function')))) {
                    return await this._runDuckDbReplOrCli((mod.AsyncDuckDB || mod.createDuckDB || mod.createConnection) ? mod : target, args);
                }

                // 3. QuickJS VM (`getQuickJS` / `newQuickJSWASMModule`)
                if (mod && (typeof mod.getQuickJS === 'function' || typeof mod.newQuickJSWASMModule === 'function' || (target && typeof target.getQuickJS === 'function'))) {
                    return await this._runQuickJsReplOrCli(mod.getQuickJS || mod.newQuickJSWASMModule ? mod : target, args);
                }

                // 4. Lua Wasmoon VM (`LuaFactory`)
                if ((mod && typeof mod.LuaFactory === 'function') || (target && typeof target.LuaFactory === 'function')) {
                    return await this._runLuaReplOrCli(mod.LuaFactory || target.LuaFactory, args);
                }

                // 5. Fallback to standard non-REPL WASM execution (or generic line-by-line WASM REPL if no args)
                if (args.length > 0 || (this.stdin && String(this.stdin).trim())) {
                    return await this._delegateToBaseWasm(args);
                }

                const replCfg = typeof pkgMeta.repl === 'object' ? pkgMeta.repl : {};
                return await this.startRepl({
                    title: replCfg.title || `${binName} (${pkgMeta.name} ${pkgMeta.version || 'wasm'})`,
                    banner: replCfg.banner || [`${pkgMeta.name} (${pkgMeta.version || 'wasm'}) — Type ".exit" or Ctrl+D to quit.`],
                    prompt: replCfg.prompt || `${binName}> `,
                    onEvaluate: async (line) => {
                        const evalFlag = replCfg.evalFlag || '-e';
                        return this._captureBaseWasmOutput([evalFlag, line]);
                    }
                });
            } catch (err) {
                this.stdErr = `${binName}: ${err.message || err}`;
                this.exitCode = 1;
            }
        }

        async _delegateToBaseWasm(args) {
            const base = new BaseWasmCmd(args, this.context);
            base.fs = this.fs;
            if (this.stdin !== undefined) base.stdin = this.stdin;
            await base.run();
            for (const line of base.result.getStdOutput()) {
                if (line.type === 'out') this.stdOut = line.string;
                else if (line.type === 'err') this.stdErr = line.string;
            }
            this.exitCode = base.exitCode || base.result.getExitCode();
        }

        async _captureBaseWasmOutput(args, stdinText) {
            const base = new BaseWasmCmd(args, this.context);
            base.fs = this.fs;
            if (stdinText !== undefined) base.stdin = stdinText;
            await base.run();
            const out = [];
            for (const line of base.result.getStdOutput()) {
                out.push(line.string);
            }
            return out;
        }

        async _runPyodideReplOrCli(mod, args) {
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

        async _runDuckDbReplOrCli(mod, args) {
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

        async _runQuickJsReplOrCli(mod, args) {
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

        async _runLuaReplOrCli(LuaFactory, args) {
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
    }

    return ReplWasmCommand;
}

ReplCommand.createReplWasmCommand = createReplWasmCommand;
module.exports = ReplCommand;

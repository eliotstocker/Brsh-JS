'use strict';

const InteractiveCommand = require('../InteractiveCommand');
const { createGenericWasmCommand } = require('./runtime');

const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const RESET = '\x1b[0m';
const INVERT = '\x1b[7m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';

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
            if (customExit || trimmed === '.exit' || trimmed === '.quit' || trimmed === '\\q' || trimmed === 'exit' || trimmed === 'quit' || trimmed === 'exit()' || trimmed === 'quit()') {
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
 * Generic REPL extension of `createGenericWasmCommand` for WBT packages with `repl` configured.
 *
 * - Non-interactive invocations (flags, script files, inline queries, or piped `stdin`) delegate
 *   directly to the base generic WASM runtime (`createGenericWasmCommand`).
 * - Interactive invocations (no script/eval arguments and no piped `stdin`) launch the terminal
 *   REPL via `ReplCommand` and evaluate each entered line through the generic WASM command.
 */
function createReplWasmCommand(pkgMeta, wbtConfig = {}, binNameOverride = null) {
    const binName = (binNameOverride || pkgMeta.bin || pkgMeta.name).toLowerCase();
    const BaseWasmCmd = createGenericWasmCommand(pkgMeta, wbtConfig, binName);
    const replCfg = (pkgMeta && typeof pkgMeta.repl === 'object') ? pkgMeta.repl : {};

    class ReplWasmCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }

        constructor(args, context) {
            super(args, context);
            this._sessionArgs = [];
            this._isInteractiveMode = this._detectInteractiveMode(args || []);
        }

        _detectInteractiveMode(args) {
            if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-V') || args.includes('-v')) {
                return false;
            }
            if (args.length === 0) {
                return true;
            }
            // If `sessionArg: true` is configured (e.g. `sqlite3 /path/to/db.sqlite`), a single
            // target file path argument with no inline query opens an interactive REPL bound to that target.
            if (replCfg.sessionArg && args.length === 1 && !args[0].startsWith('-')) {
                const arg = args[0].trim();
                const looksLikeQuery = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA|WITH|BEGIN|EXPLAIN|\.)\b/i.test(arg);
                if (!looksLikeQuery) {
                    this._sessionArgs = [args[0]];
                    return true;
                }
            }
            return false;
        }

        shouldBeInteractive() {
            if (this._dynamicReplActive) return true;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) {
                return false;
            }
            return this._isInteractiveMode;
        }

        getReplTitle() {
            const suffix = this._sessionArgs.length > 0 ? ` — ${this._sessionArgs.join(' ')}` : '';
            return replCfg.title || `${binName} (${pkgMeta.name} ${pkgMeta.version || 'wasm'})${suffix}`;
        }

        getReplPrompt() {
            if (this._dynamicReplMultiline && replCfg.continuePrompt) {
                return replCfg.continuePrompt;
            }
            return replCfg.prompt || `${binName}> `;
        }

        getReplWelcome() {
            return replCfg.banner || [
                `${pkgMeta.name} (${pkgMeta.version || 'wasm'}) interactive shell`,
                `Type ".exit" or Ctrl+D to quit.`
            ];
        }

        async evaluateReplLine(line) {
            const evalFlag = replCfg.evalFlag;
            const invokeArgs = evalFlag
                ? [...this._sessionArgs, evalFlag, line]
                : [...this._sessionArgs, line];
            const stdinText = evalFlag ? undefined : line;
            const { out, err } = await this._captureBaseWasmOutput(invokeArgs, stdinText);
            return {
                output: out,
                error: err.length > 0 ? err.join('\n') : undefined
            };
        }

        async runNonInteractive() {
            await this._delegateToBaseWasm([...(this.arguments || [])]);
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
            const err = [];
            for (const line of base.result.getStdOutput()) {
                if (line.type === 'err') err.push(line.string);
                else out.push(line.string);
            }
            return { out, err };
        }
    }

    return ReplWasmCommand;
}

ReplCommand.createReplWasmCommand = createReplWasmCommand;
module.exports = ReplCommand;

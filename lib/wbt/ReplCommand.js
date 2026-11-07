'use strict';

const InteractiveCommand = require('../InteractiveCommand');

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
 * 2. Full-screen interactive REPL mode (`runInteractive()`) when invoked with no query/script
 *
 * Subclasses override:
 * - `shouldBeInteractive()` -> boolean
 * - `getReplTitle()` -> string (shown in header bar)
 * - `getReplPrompt()` -> string (e.g. 'sqlite> ' or 'postgres=# ')
 * - `getReplWelcome()` -> string[] (initial lines in REPL)
 * - `initRepl()` -> Promise<void> (async setup before REPL accepts input)
 * - `evaluateReplLine(line)` -> Promise<{ output?: string[], error?: string, exit?: boolean, clear?: boolean }>
 * - `cleanupRepl()` -> Promise<void> (called on exit)
 * - `runNonInteractive()` -> Promise<void>
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
        return false;
    }

    getReplTitle() {
        return `${this.name} interactive shell`;
    }

    getReplPrompt() {
        return `${this.name}> `;
    }

    getReplWelcome() {
        return [`Welcome to ${this.name}. Type .exit or Ctrl+D to quit.`];
    }

    async initRepl() {}

    async evaluateReplLine(_line) {
        return { output: [] };
    }

    async cleanupRepl() {}

    async runNonInteractive() {}

    run() {
        if (!this.shouldBeInteractive()) {
            return Promise.resolve(this.runNonInteractive());
        }

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

        // Allow Ctrl+C or Ctrl+D even when busy
        if (key === '^D' || key === '^X') {
            this._exitRepl();
            return;
        }
        if (key === '^C') {
            if (this._replInput.length > 0) {
                this._appendReplLog(`${this.getReplPrompt()}${this._replInput}^C`, 'prompt');
                this._replInput = '';
                this._replCursor = 0;
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
            if (trimmed === '.exit' || trimmed === '.quit' || trimmed === '\\q' || trimmed === 'exit' || trimmed === 'quit') {
                this._exitRepl();
                return;
            }
            if (trimmed === '.clear' || trimmed === '\\! clear') {
                this._replLog = [];
                this._renderRepl();
                return;
            }

            this._replBusy = true;
            this._replStatus = 'Running...';
            this._renderRepl();

            Promise.resolve()
                .then(() => this.evaluateReplLine(line))
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
        const bodyRows = Math.max(3, rows - 3); // 1 header row, 1 prompt row, 1 status row

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

        // Render prompt + input line with cursor
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

module.exports = ReplCommand;

'use strict';

import _Shell from 'brsh';
import '../styles/terminal.css';
import { ScreenBuffer } from './terminal/ScreenBuffer.js';
import { VtParser, DEFAULT_URL_WHITELIST } from './terminal/VtParser.js';
import { DomRenderer } from './terminal/DomRenderer.js';
import { spawnPty } from './terminal/PtyBridge.js';

const ImportedShell = _Shell?.default ?? _Shell;

class MiniEventStream {
    constructor() {
        this._listeners = new Map();
        this.readable = true;
        this.writable = true;
        this.isTTY = true;
    }

    on(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
        return this;
    }

    addListener(event, fn) {
        return this.on(event, fn);
    }

    once(event, fn) {
        const wrapper = (...args) => {
            this.removeListener(event, wrapper);
            fn(...args);
        };
        return this.on(event, wrapper);
    }

    removeListener(event, fn) {
        const list = this._listeners.get(event);
        if (!list) return this;
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
        return this;
    }

    off(event, fn) {
        return this.removeListener(event, fn);
    }

    removeAllListeners(event) {
        if (event) this._listeners.delete(event);
        else this._listeners.clear();
        return this;
    }

    listeners(event) {
        return [...(this._listeners.get(event) || [])];
    }

    emit(event, ...args) {
        const list = this._listeners.get(event);
        if (!list || list.length === 0) return false;
        for (const fn of [...list]) {
            fn(...args);
        }
        return true;
    }

    setRawMode(flag) {
        this.isRaw = Boolean(flag);
        return this;
    }

    resume() { return this; }
    pause() { return this; }
    setEncoding(enc) {
        this._encoding = enc;
        return this;
    }
    pipe(dest) {
        this.on('data', chunk => dest.write(chunk));
        return dest;
    }
    unpipe() { return this; }
    destroy() {
        this.removeAllListeners();
    }
}

class Terminal {
    constructor(options = {}) {
        const {
            el,
            font = 'Roboto Mono',
            cursor = 'none',
            outputAnimation = 'none',
            animateSpeed = 1,
            onExit = null,
            mobileInput = 'click',
            lineWrap = false,
            command = null,
            cols = 80,
            rows = 24,
            maxScrollback = 1000,
            stream = null
        } = options;

        if (!el) {
            throw new Error('you must set `el` option');
        }

        if (!['none', 'block', 'blink'].includes(cursor)) {
            throw new Error('cursor value must be one of: \'none\', \'block\', \'blink\'');
        }

        if (!['none', 'type'].includes(outputAnimation)) {
            throw new Error('outputAnimation value must be one of: \'none\', \'type\'');
        }

        if (!Number.isInteger(animateSpeed) || animateSpeed < 1 || animateSpeed > 20) {
            throw new Error('animateSpeed value must be between 1 and 20');
        }

        this._exitFn = onExit;
        this._cursor = cursor;
        this._outputAnimation = outputAnimation;
        this._animateSpeed = animateSpeed;
        this._lineWrap = lineWrap;
        this._el = el;

        this._dataListeners = [];
        this._resizeListeners = [];
        this._titleListeners = [];
        this._mouseButtonDown = null;

        this._mobileInputElement = null;
        this._onMobileInputClick = null;
        this._typeQueue = '';
        this._typeTimer = null;
        this._isHandlingInput = false;
        this._suppressAnimationUntil = 0;

        this.screen = new ScreenBuffer(cols, rows, { maxScrollback });
        this.parser = new VtParser(this.screen, {
            urlWhitelist: DEFAULT_URL_WHITELIST,
            onResponse: (resp) => this._emitInput(resp),
            onTitle: (title) => {
                this.title = title;
                for (const fn of this._titleListeners) fn(title);
            }
        });

        // Resolve optional brsh Shell instance unless stream-only or Shell: false
        this.cli = options.cli || options.shell || null;
        if (!this.cli && !stream && options.Shell !== false) {
            const ShellClass = options.Shell === null
                ? null
                : (options.Shell
                    || (typeof globalThis !== 'undefined' && (globalThis.Shell || globalThis.shell))
                    || (typeof ImportedShell === 'function' ? ImportedShell : null));

            if (!ShellClass) {
                throw new Error('Shell is required by Terminal. Please import Shell from "brsh" or include shell.min.js before terminal.min.js.');
            }
            this.cli = new ShellClass(Object.assign({}, options, { command: undefined }));
        }

        this._setupDom(this._el, font);
        this.renderer = new DomRenderer(this._cmdList, this.screen, {
            cursor: this._cursor,
            urlWhitelist: DEFAULT_URL_WHITELIST
        });

        this._listenForEvents();

        if (this.cli) {
            this.attach(this.cli);
            if (typeof this.cli.on === 'function') {
                this.cli.on('exit', (code) => {
                    delete this.cli;
                    if (typeof this._exitFn === 'function') {
                        this._exitFn(code);
                    }
                });
            }
            if (command) {
                this.onCommand(command);
            }
        }

        if (stream) {
            this.attach(stream);
            if (command) {
                this.onCommand(command);
            }
        }

        if (mobileInput === 'click') {
            this._mobileInput();
        }

        this.renderer.flushRender();
    }

    get cols() {
        return this.screen.cols;
    }

    get rows() {
        return this.screen.rows;
    }

    /**
     * Feed raw terminal output (including ANSI/VT100 escape sequences) into the terminal.
     */
    write(data) {
        if (data == null || data === '') return;
        const str = typeof data === 'string'
            ? data
            : (data instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)))
                ? new TextDecoder().decode(data)
                : String(data);

        if (this._outputAnimation === 'type') {
            if (this._isUserInputActive() || this._isFullScreenWrite(str)) {
                this._flushTypeQueue();
                this.parser.write(str);
                this.renderer.flushRender();
                this._autoScroll();
                return;
            }

            if (this._isLineRewrite(str) || !/[^\r\n]/.test(str)) {
                if (!this._typeQueue || !this._typeQueue.includes('\n')) {
                    this._flushTypeQueue();
                    this.parser.write(str);
                    this.renderer.flushRender();
                    this._autoScroll();
                    return;
                }
            }

            this._enqueueTypeAnimation(str);
            return;
        }

        this.parser.write(str);
        this.renderer.flushRender();
        this._autoScroll();
    }

    writeln(data = '') {
        this.write(String(data) + '\r\n');
    }

    clear() {
        this.write('\x1b[2J\x1b[3J\x1b[H');
    }

    reset() {
        this._flushTypeQueue();
        this.parser.reset();
        this.renderer.flushRender();
        this._mobileInputBuffer = '';
        if (this._mobileInputElement) {
            this._mobileInputElement.value = '';
        }
    }

    /**
     * Subscribe to raw terminal input sequences (keystrokes, paste, mouse reports, DSR responses).
     */
    onData(callback) {
        if (typeof callback !== 'function') return () => {};
        this._dataListeners.push(callback);
        return () => {
            const idx = this._dataListeners.indexOf(callback);
            if (idx !== -1) this._dataListeners.splice(idx, 1);
        };
    }

    /**
     * Subscribe to terminal resize events `{ cols, rows }`.
     */
    onResize(callback) {
        if (typeof callback !== 'function') return () => {};
        this._resizeListeners.push(callback);
        return () => {
            const idx = this._resizeListeners.indexOf(callback);
            if (idx !== -1) this._resizeListeners.splice(idx, 1);
        };
    }

    onTitleChange(callback) {
        if (typeof callback !== 'function') return () => {};
        this._titleListeners.push(callback);
        return () => {
            const idx = this._titleListeners.indexOf(callback);
            if (idx !== -1) this._titleListeners.splice(idx, 1);
        };
    }

    /**
     * Resize the terminal grid to `(cols, rows)`.
     */
    resize(cols, rows) {
        const c = Math.max(1, Math.floor(cols));
        const r = Math.max(1, Math.floor(rows));
        if (c === this.screen.cols && r === this.screen.rows && this._lastCols === c && this._lastRows === r) {
            return;
        }
        this._lastCols = c;
        this._lastRows = r;
        this.screen.resize(c, r);
        if (this.cli && typeof this.cli.setTerminalSize === 'function') {
            this.cli.setTerminalSize(c, r);
        }
        for (const fn of this._resizeListeners) {
            fn({ cols: c, rows: r });
        }
        this.renderer.flushRender();
    }

    /**
     * Attach an external shell / PTY / Duplex stream (e.g. zsh, bash, WebSocket bridge).
     */
    attach(stream) {
        if (!stream) return () => {};
        this._attachedStream = stream;

        const onStreamData = (chunk) => {
            this.write(chunk);
        };

        if (typeof stream.on === 'function') {
            stream.on('data', onStreamData);
        } else if (typeof stream.addEventListener === 'function') {
            stream.addEventListener('message', (ev) => this.write(ev.data ?? ev));
        }

        const offData = this.onData((data) => {
            if (typeof stream.write === 'function') {
                stream.write(data);
            } else if (typeof stream.send === 'function') {
                stream.send(data);
            }
        });

        const offResize = this.onResize(({ cols, rows }) => {
            if (typeof stream.resize === 'function') {
                stream.resize(cols, rows);
            }
        });

        if (typeof stream.resize === 'function') {
            stream.resize(this.cols, this.rows);
        }

        return () => {
            offData();
            offResize();
            if (typeof stream.removeListener === 'function') {
                stream.removeListener('data', onStreamData);
            }
            if (this._attachedStream === stream) {
                this._attachedStream = null;
            }
        };
    }

    /**
     * Spawn an external shell/command (e.g. '/bin/zsh' or '$SHELL') in a real OS PTY and attach it to this Terminal.
     */
    spawn(command, args = [], options = {}) {
        const pty = spawnPty(command, args, Object.assign({
            cols: this.cols,
            rows: this.rows
        }, options));
        const detach = this.attach(pty);
        pty.on('exit', (code) => {
            if (typeof this._exitFn === 'function') {
                this._exitFn(code);
            }
        });
        return { pty, detach };
    }

    /**
     * Create a Node-compatible `{ stdin, stdout }` TTY stream pair wired to this Terminal.
     * Can be passed directly to `blessed.screen({ input: tty.stdin, output: tty.stdout })`
     * or Node's `readline`.
     */
    createTty(options = {}) {
        const stdin = new MiniEventStream();
        const stdout = new MiniEventStream();
        const interceptShell = options.interceptShell !== false;

        stdout.columns = this.cols;
        stdout.rows = this.rows;
        stdout.getWindowSize = () => [stdout.columns, stdout.rows];
        stdout.write = (chunk, enc, cb) => {
            this.write(chunk);
            if (typeof enc === 'function') enc();
            else if (typeof cb === 'function') cb();
            return true;
        };

        const offData = this.onData((data) => {
            const payload = stdin._encoding
                ? data
                : (typeof Buffer !== 'undefined' ? Buffer.from(data, 'utf8') : data);
            stdin.emit('data', payload);
        });

        const offResize = this.onResize(({ cols, rows }) => {
            stdout.columns = cols;
            stdout.rows = rows;
            stdout.emit('resize');
        });

        const dispose = () => {
            offData();
            offResize();
            stdin.destroy();
            stdout.destroy();
        };

        return { stdin, stdout, dispose };
    }

    /**
     * Programmatically send a key press (with optional `{ alt, ctrl, shift }` modifiers).
     */
    sendKey(key, modifiers = {}) {
        const seq = this._encodeKey(key, modifiers);
        if (seq) {
            this._emitInput(seq);
        }
    }

    /**
     * Programmatically or DOM-triggered mouse event at 1-based `(col, row)`.
     */
    sendMouse(type, { button = 0, col = 1, row = 1, shift = false, alt = false, ctrl = false, deltaY = 0 } = {}) {
        const mode = this.parser.mouseTrackingMode;
        const c = Math.max(1, Math.min(this.cols, col));
        const r = Math.max(1, Math.min(this.rows, row));

        // When TUI mouse mode is off (or Shift is held), handle native scrollback / alt-scroll
        if (mode === 0 || shift) {
            if (type === 'wheel') {
                if (this.screen.isAltScreen && this.parser.alternateScrollMode) {
                    const arrow = deltaY < 0 ? 'ArrowUp' : 'ArrowDown';
                    this.sendKey(arrow);
                } else if (!this.screen.isAltScreen) {
                    this.screen.scrollViewport(deltaY < 0 ? 3 : -3);
                    this.renderer.flushRender();
                }
            }
            return false;
        }

        let btnCode = button;
        if (type === 'wheel') {
            btnCode = deltaY < 0 ? 64 : 65;
        } else if (type === 'mousemove') {
            if (mode === 1000) return false;
            if (mode === 1002 && this._mouseButtonDown === null) return false;
            btnCode = (this._mouseButtonDown ?? 0) + 32;
        } else if (type === 'mousedown') {
            this._mouseButtonDown = button;
        } else if (type === 'mouseup') {
            this._mouseButtonDown = null;
            if (this.parser.mouseProtocol !== 'sgr') {
                btnCode = 3;
            }
        }

        if (shift) btnCode += 4;
        if (alt) btnCode += 8;
        if (ctrl) btnCode += 16;

        if (this.parser.mouseProtocol === 'sgr') {
            const suffix = type === 'mouseup' ? 'm' : 'M';
            this._emitInput(`\x1b[<${btnCode};${c};${r}${suffix}`);
            return true;
        }

        // X10 / UTF-8 protocol
        const maxCoord = this.parser.mouseProtocol === 'utf8' ? 2015 : 223;
        const clampedCol = Math.min(maxCoord, c);
        const clampedRow = Math.min(maxCoord, r);
        this._emitInput(
            '\x1b[M'
            + String.fromCharCode(32 + btnCode)
            + String.fromCharCode(32 + clampedCol)
            + String.fromCharCode(32 + clampedRow)
        );
        return true;
    }

    onCommand(command) {
        if (this.cli && typeof this.cli.sendCommand === 'function') {
            this.cli.sendCommand(command);
        } else {
            this._emitInput(String(command) + '\r');
        }
    }

    getScreenText(options) {
        this.renderer.flushRender();
        return this.screen.getScreenText(options);
    }

    getLineText(row, trimRight = true) {
        this.renderer.flushRender();
        return this.screen.getLineText(row, trimRight);
    }

    _emitInput(data) {
        if (!data) return;
        // Snap viewport back to bottom on user input
        if (this.screen.viewportOffset > 0) {
            this.screen.viewportOffset = 0;
            this.screen._markAllDirty();
            this.renderer.flushRender();
        }
        // Flush any in-progress typing animation when the user interacts with the terminal
        if (this._typeQueue || this._typeTimer !== null) {
            this._flushTypeQueue();
            this.renderer.flushRender();
            this._autoScroll();
        }
        const isPureEnter = data === '\r' || data === '\n' || data === '\r\n';
        if (isPureEnter && this._mobileInputElement) {
            this._mobileInputElement.value = '';
            this._mobileInputBuffer = '';
        }
        this._suppressAnimationUntil = isPureEnter ? 0 : Date.now() + 80;
        this._isHandlingInput = !isPureEnter;
        try {
            for (const fn of this._dataListeners) {
                fn(data);
            }
        } finally {
            this._isHandlingInput = false;
        }
    }

    _flushTypeQueue() {
        if (this._typeTimer !== null) {
            clearInterval(this._typeTimer);
            this._typeTimer = null;
        }
        if (this._typeQueue) {
            const pending = this._typeQueue;
            this._typeQueue = '';
            this.parser.write(pending);
        }
    }

    _isUserInputActive() {
        if (this._isHandlingInput) return true;
        if (this._suppressAnimationUntil && Date.now() < this._suppressAnimationUntil) {
            return true;
        }
        return false;
    }

    _isFullScreenWrite(str) {
        if (this.screen.isAltScreen) return true;
        if (this.cli && this.cli.runningCommand) {
            const cmd = this.cli.runningCommand;
            if (cmd.interactive || cmd._inAltScreen || (cmd.stdinStream && cmd.stdinStream.isRaw)) {
                return true;
            }
        }
        if (this._attachedStream && this._attachedStream.isRaw) {
            return true;
        }
        // Alternate screen buffer enter/exit or full-screen 2D cursor/screen control sequences
        if (/\x1b\[\?(?:1049|1047|47)[hl]/.test(str)) return true;
        if (/\x1b\[(?:\d*J|(?:\d+;\d+)?[Hf]|\d*[ABLM]|\d*;\d*r)/.test(str)) return true;
        return false;
    }

    _isLineRewrite(str) {
        // Bare carriage return (\r not followed by \n) rewrites the current line in-place
        if (/\r(?!\n)/.test(str)) return true;
        // In-line erase (EL) or horizontal cursor movement / char insert-delete
        if (/\x1b\[\d*[KCDG@P]/.test(str)) return true;
        // Backspace / delete character editing on the current line
        if (/[\x08\x7f]/.test(str)) return true;
        return false;
    }

    _encodeKey(key, modifiers = {}) {
        const { alt = false, ctrl = false, shift = false, meta = false } = modifiers;
        if (!key || ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(key)) {
            return null;
        }

        // Allow native browser copy/paste/reload shortcuts with Meta (Cmd on macOS)
        if (meta) return null;

        const appCursor = this.parser.applicationCursorKeys;

        if (key === 'ArrowUp') {
            if (alt) return '\x1b[1;3A';
            if (ctrl) return '\x1b[1;5A';
            return appCursor ? '\x1bOA' : '\x1b[A';
        }
        if (key === 'ArrowDown') {
            if (alt) return '\x1b[1;3B';
            if (ctrl) return '\x1b[1;5B';
            return appCursor ? '\x1bOB' : '\x1b[B';
        }
        if (key === 'ArrowRight') {
            if (alt) return '\x1b[1;3C';
            if (ctrl) return '\x1b[1;5C';
            return appCursor ? '\x1bOC' : '\x1b[C';
        }
        if (key === 'ArrowLeft') {
            if (alt) return '\x1b[1;3D';
            if (ctrl) return '\x1b[1;5D';
            return appCursor ? '\x1bOD' : '\x1b[D';
        }
        if (key === 'Home') return appCursor ? '\x1bOH' : '\x1b[H';
        if (key === 'End') return appCursor ? '\x1bOF' : '\x1b[F';
        if (key === 'Delete') return '\x1b[3~';
        if (key === 'Insert') return '\x1b[2~';
        if (key === 'PageUp') return '\x1b[5~';
        if (key === 'PageDown') return '\x1b[6~';
        if (key === 'Enter') return '\r';
        if (key === 'Backspace') return alt ? '\x1b\x7f' : '\x7f';
        if (key === 'Tab') return shift ? '\x1b[Z' : '\t';
        if (key === 'Escape') return '\x1b';

        const fnMatch = key.match(/^F(\d{1,2})$/);
        if (fnMatch) {
            const fnMap = {
                1: '\x1bOP', 2: '\x1bOQ', 3: '\x1bOR', 4: '\x1bOS',
                5: '\x1b[15~', 6: '\x1b[17~', 7: '\x1b[18~', 8: '\x1b[19~',
                9: '\x1b[20~', 10: '\x1b[21~', 11: '\x1b[23~', 12: '\x1b[24~'
            };
            return fnMap[Number(fnMatch[1])] || null;
        }

        if (ctrl && key.length === 1) {
            const upper = key.toUpperCase().charCodeAt(0);
            if (upper >= 64 && upper <= 95) {
                const ctrlChar = String.fromCharCode(upper - 64);
                return alt ? '\x1b' + ctrlChar : ctrlChar;
            }
        }

        if (key.length === 1) {
            return alt ? '\x1b' + key : key;
        }

        return null;
    }

    _enqueueTypeAnimation(str) {
        this._typeQueue += str;
        if (this._typeTimer !== null) return;

        this._typeTimer = setInterval(() => {
            if (!this._typeQueue) {
                clearInterval(this._typeTimer);
                this._typeTimer = null;
                return;
            }

            if (this._isFullScreenWrite(this._typeQueue)) {
                this._flushTypeQueue();
                this.renderer.flushRender();
                this._autoScroll();
                return;
            }

            let count = 0;
            let idx = 0;

            // If the current line segment in the queue is an in-place line rewrite (e.g. trailing prompt or progress update),
            // consume the entire line segment in one step instead of animating it character-by-character.
            const nlIdx = this._typeQueue.indexOf('\n');
            const lineEnd = nlIdx === -1 ? this._typeQueue.length : nlIdx + 1;
            const currentLine = this._typeQueue.slice(0, lineEnd);
            if (this._isLineRewrite(currentLine)) {
                idx = lineEnd;
            } else {
                while (idx < this._typeQueue.length && count < this._animateSpeed) {
                    if (this._typeQueue.charCodeAt(idx) === 0x1b) {
                        // Consume entire escape sequence in one step so partial sequences don't stall
                        idx++;
                        if (this._typeQueue[idx] === '[') {
                            idx++;
                            while (idx < this._typeQueue.length && this._typeQueue.charCodeAt(idx) < 0x40) {
                                idx++;
                            }
                            if (idx < this._typeQueue.length) idx++;
                        } else if (this._typeQueue[idx] === ']') {
                            idx++;
                            while (idx < this._typeQueue.length && this._typeQueue.charCodeAt(idx) !== 0x07) {
                                if (this._typeQueue.charCodeAt(idx) === 0x1b && this._typeQueue[idx + 1] === '\\') {
                                    idx += 2;
                                    break;
                                }
                                idx++;
                            }
                            if (idx < this._typeQueue.length && this._typeQueue.charCodeAt(idx) === 0x07) idx++;
                        } else if (idx < this._typeQueue.length) {
                            idx++;
                        }
                    } else {
                        idx++;
                        count++;
                    }
                }
            }

            // If only a trailing line rewrite (such as the shell prompt) remains after this slice, flush it immediately
            const remainder = this._typeQueue.slice(idx);
            if (remainder && !remainder.includes('\n') && this._isLineRewrite(remainder)) {
                idx = this._typeQueue.length;
            }

            const slice = this._typeQueue.slice(0, idx);
            this._typeQueue = this._typeQueue.slice(idx);
            this.parser.write(slice);
            this.renderer.flushRender();
            this._autoScroll();
        }, 10);
    }

    _setupDom(parent, font = 'Roboto Mono') {
        if (typeof document === 'undefined') return;

        const style = document.createElement('link');
        style.href = `https://fonts.googleapis.com/css?family=${encodeURIComponent(font)}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
        style.rel = 'stylesheet';
        if (document.head && document.head.appendChild) {
            document.head.appendChild(style);
        }

        this._cmdList = document.createElement('ul');
        this._cmdList.style.fontFamily = `'${font}', monospace`;
        this._cmdList.style.listStyle = 'none';
        this._cmdList.style.padding = '0';
        this._cmdList.style.margin = '0';
        if (this._lineWrap) {
            this._cmdList.classList.add('terminal--wrap');
        }
        parent.appendChild(this._cmdList);

        this._charMeasure = document.createElement('span');
        this._charMeasure.className = 'terminal__char-measure';
        this._charMeasure.style.fontFamily = `'${font}', monospace`;
        this._charMeasure.textContent = 'X';
        this._charMeasure.setAttribute('aria-hidden', 'true');
        parent.appendChild(this._charMeasure);

        setTimeout(() => this._measureAndSetSize(), 0);
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => this._measureAndSetSize());
        }
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => this._measureAndSetSize()).observe(parent);
        }
    }

    _listenForEvents() {
        if (typeof window === 'undefined') return;

        this._onKeyDown = (e) => {
            if (e.metaKey) return;
            const seq = this._encodeKey(e.key, {
                alt: Boolean(e.altKey),
                ctrl: Boolean(e.ctrlKey),
                shift: Boolean(e.shiftKey),
                meta: Boolean(e.metaKey)
            });
            if (seq) {
                if (e.preventDefault) e.preventDefault();
                this._emitInput(seq);
            }
        };

        this._onPaste = (e) => {
            const clipboard = e.clipboardData || (typeof window !== 'undefined' && window.clipboardData);
            if (!clipboard || typeof clipboard.getData !== 'function') return;
            const text = clipboard.getData('text');
            if (!text) return;
            if (e.preventDefault) e.preventDefault();

            const normalized = text.replace(/\r?\n/g, '\r');
            if (this.parser.bracketedPasteMode) {
                this._emitInput(`\x1b[200~${normalized}\x1b[201~`);
            } else {
                this._emitInput(normalized);
            }
        };

        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('paste', this._onPaste);

        if (this._el && typeof this._el.addEventListener === 'function') {
            const coordsFromMouse = (e) => {
                if (!this._charMeasure || !this._el.getBoundingClientRect) {
                    return { col: 1, row: 1 };
                }
                const charRect = this._charMeasure.getBoundingClientRect();
                const box = this._el.getBoundingClientRect();
                const cw = charRect.width || 8;
                const ch = charRect.height || 16;
                const col = Math.max(1, Math.min(this.cols, Math.floor(((e.clientX || 0) - box.left) / cw) + 1));
                const row = Math.max(1, Math.min(this.rows, Math.floor(((e.clientY || 0) - box.top) / ch) + 1));
                return { col, row };
            };

            this._el.addEventListener('mousedown', (e) => {
                // Allow clicking links when TUI mouse tracking is off or Cmd/Ctrl is held
                const target = e.target;
                if (target && target.tagName === 'A' && (this.parser.mouseTrackingMode === 0 || e.metaKey || e.ctrlKey)) {
                    return;
                }
                const { col, row } = coordsFromMouse(e);
                const handled = this.sendMouse('mousedown', {
                    button: e.button || 0,
                    col,
                    row,
                    shift: Boolean(e.shiftKey),
                    alt: Boolean(e.altKey),
                    ctrl: Boolean(e.ctrlKey)
                });
                if (handled && e.preventDefault) e.preventDefault();
            });

            this._el.addEventListener('mouseup', (e) => {
                const { col, row } = coordsFromMouse(e);
                const handled = this.sendMouse('mouseup', {
                    button: e.button || 0,
                    col,
                    row,
                    shift: Boolean(e.shiftKey),
                    alt: Boolean(e.altKey),
                    ctrl: Boolean(e.ctrlKey)
                });
                if (handled && e.preventDefault) e.preventDefault();
            });

            this._el.addEventListener('mousemove', (e) => {
                if (this.parser.mouseTrackingMode === 0) return;
                const { col, row } = coordsFromMouse(e);
                this.sendMouse('mousemove', {
                    button: e.button || 0,
                    col,
                    row,
                    shift: Boolean(e.shiftKey),
                    alt: Boolean(e.altKey),
                    ctrl: Boolean(e.ctrlKey)
                });
            });

            this._el.addEventListener('wheel', (e) => {
                const { col, row } = coordsFromMouse(e);
                const handled = this.sendMouse('wheel', {
                    col,
                    row,
                    deltaY: e.deltaY || 0,
                    shift: Boolean(e.shiftKey),
                    alt: Boolean(e.altKey),
                    ctrl: Boolean(e.ctrlKey)
                });
                if (handled && e.preventDefault) e.preventDefault();
            });
        }
    }

    _mobileInput() {
        if (typeof document === 'undefined' || !this._el) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.style.position = 'fixed';
        input.style.top = '0';
        input.style.left = '0';
        input.style.width = '0';
        input.style.height = '0';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        input.style.zIndex = '-1';
        input.setAttribute('aria-hidden', 'true');
        input.setAttribute('tabindex', '-1');
        input.setAttribute('autocapitalize', 'none');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('enterkeyhint', 'go');
        this._el.appendChild(input);
        this._mobileInputElement = input;
        this._mobileInputBuffer = '';

        this._onMobileInputClick = (e) => {
            // Avoid stealing focus when clicking hyperlinks
            if (e && e.target && e.target.tagName === 'A') return;
            if (typeof input.focus === 'function') {
                input.focus({ preventScroll: true });
                if (typeof input.setSelectionRange === 'function') {
                    const len = (input.value || '').length;
                    input.setSelectionRange(len, len);
                }
            }
        };
        this._el.addEventListener('click', this._onMobileInputClick);

        const applyDiff = () => {
            const oldVal = this._mobileInputBuffer || '';
            const newVal = input.value || '';
            if (oldVal === newVal) return;

            let prefix = 0;
            while (prefix < oldVal.length && prefix < newVal.length && oldVal[prefix] === newVal[prefix]) {
                prefix++;
            }

            let suffix = 0;
            while (
                suffix < (oldVal.length - prefix) &&
                suffix < (newVal.length - prefix) &&
                oldVal[oldVal.length - 1 - suffix] === newVal[newVal.length - 1 - suffix]
            ) {
                suffix++;
            }

            const deletedCount = oldVal.length - prefix - suffix;
            const insertedText = newVal.slice(prefix, newVal.length - suffix);

            if (deletedCount > 0) {
                for (let i = 0; i < deletedCount; i++) {
                    this.sendKey('Backspace');
                }
            }

            if (insertedText) {
                const normalized = insertedText.replace(/\r?\n/g, '\r');
                this._emitInput(normalized);
            }

            this._mobileInputBuffer = newVal;
        };

        const onInput = (e) => {
            if (!e) {
                applyDiff();
                return;
            }

            const inputType = e.inputType;
            if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
                this.sendKey('Enter');
                input.value = '';
                this._mobileInputBuffer = '';
                return;
            }

            if (inputType === 'deleteContentBackward') {
                this.sendKey('Backspace');
                this._mobileInputBuffer = input.value || '';
                return;
            }

            if (inputType === 'deleteContentForward') {
                this.sendKey('Delete');
                this._mobileInputBuffer = input.value || '';
                return;
            }

            if (inputType === 'deleteWordBackward') {
                this.sendKey('Backspace', { alt: true });
                this._mobileInputBuffer = input.value || '';
                return;
            }

            if (inputType === 'insertText' && typeof e.data === 'string' && e.data.length > 0) {
                const expectedLen = (this._mobileInputBuffer || '').length + e.data.length;
                if (!input.value || input.value.length === expectedLen) {
                    const normalized = e.data.replace(/\r?\n/g, '\r');
                    this._emitInput(normalized);
                    this._mobileInputBuffer = input.value || '';
                    return;
                }
            }

            applyDiff();
        };

        input.addEventListener('input', onInput);

        input.addEventListener('keydown', (e) => {
            if (e && (e.key === 'Enter' || e.keyCode === 13)) {
                if (!e.defaultPrevented) {
                    this.sendKey('Enter');
                    input.value = '';
                    this._mobileInputBuffer = '';
                    if (e.preventDefault) e.preventDefault();
                }
            }
        });

        input.addEventListener('keyup', (e) => {
            if (e && e.key === 'Unidentified') {
                applyDiff();
            }
        });

        input.addEventListener('compositionend', () => {
            applyDiff();
        });
    }

    _autoScroll() {
        if (!this._el || typeof this._el.scrollTo !== 'function') return;
        if (this._el.scrollTop + this._el.offsetHeight >= this._el.scrollHeight - 50) {
            this._el.scrollTo(0, this._el.scrollHeight);
        }
    }

    _measureAndSetSize() {
        if (!this._charMeasure || !this._el || typeof this._el.getBoundingClientRect !== 'function') return;
        const charRect = this._charMeasure.getBoundingClientRect();
        const containerRect = this._el.getBoundingClientRect();
        if (!charRect || !containerRect || !charRect.width || !charRect.height || !containerRect.width) return;
        // Ignore degenerate/mock measurements where single-char span equals container size
        if (charRect.width >= containerRect.width && charRect.height >= containerRect.height) return;
        const cols = Math.max(1, Math.floor(containerRect.width / charRect.width));
        const rows = Math.max(1, Math.floor((containerRect.height || (charRect.height * 24)) / charRect.height));
        if (cols !== this._lastCols || rows !== this._lastRows) {
            this.resize(cols, rows);
        }
    }

    destroy() {
        if (this._typeTimer !== null) {
            clearInterval(this._typeTimer);
            this._typeTimer = null;
        }
        if (typeof window !== 'undefined' && window.removeEventListener) {
            if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
            if (this._onPaste) window.removeEventListener('paste', this._onPaste);
        }
        if (this._mobileInputElement) {
            if (this._onMobileInputClick && this._el && typeof this._el.removeEventListener === 'function') {
                this._el.removeEventListener('click', this._onMobileInputClick);
            }
            if (this._mobileInputElement.parentNode) {
                this._mobileInputElement.parentNode.removeChild(this._mobileInputElement);
            } else if (typeof this._mobileInputElement.remove === 'function') {
                this._mobileInputElement.remove();
            }
            this._mobileInputElement = null;
        }
        this._dataListeners = [];
        this._resizeListeners = [];
        this._titleListeners = [];
    }
}

Terminal.Terminal = Terminal;
Terminal.spawnPty = spawnPty;
if (typeof globalThis !== 'undefined') {
    globalThis.Terminal = Terminal;
}
export default Terminal;

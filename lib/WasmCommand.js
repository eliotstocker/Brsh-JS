'use strict';

const ScriptCommand = require('./ScriptCommand');
const { BinaryFile } = require('./FileSystem');

// WASI errno constants
const ERRNO_SUCCESS = 0;
const ERRNO_AGAIN = 6;
const ERRNO_BADF = 8;
const ERRNO_EXIST = 20;
const ERRNO_INTR = 27;
const ERRNO_INVAL = 28;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOTDIR = 54;
const ERRNO_NOSYS = 52;
const ERRNO_SPIPE = 70;

// WASI filetype constants
const FILETYPE_UNKNOWN = 0;
const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;

// WASI oflags
const OFLAGS_CREAT = 1 << 0;
const OFLAGS_DIRECTORY = 1 << 1;
const OFLAGS_EXCL = 1 << 2;
const OFLAGS_TRUNC = 1 << 3;

// WASI fdflags
const FDFLAGS_APPEND = 1 << 0;
const FDFLAGS_DSYNC = 1 << 1;
const FDFLAGS_NONBLOCK = 1 << 2;
const FDFLAGS_RSYNC = 1 << 3;
const FDFLAGS_SYNC = 1 << 4;

// POSIX termios c_lflag ISIG bit (0000001)
const TERMIOS_ISIG = 1;

class WasmCommand extends ScriptCommand {
    // this.script = filepath (set by ScriptCommand parent constructor)
    constructor(script, args, context) {
        super(script, args, context);
        this._ensurePkgMeta();
    }

    _ensurePkgMeta() {
        if (this._pkgMeta === undefined && this.script) {
            const fs = (this.context && this.context.fs) || this.fs;
            if (fs) {
                this._pkgMeta = readSiblingPkgMeta(fs, this.script);
            }
        }
        return this._pkgMeta || null;
    }

    get name() {
        const meta = this._ensurePkgMeta();
        if (meta && meta.bin) return String(meta.bin).toLowerCase();
        if (this.script) return this.script.split('/').pop().replace(/\.(wasm|wat)$/i, '').toLowerCase();
        return 'wasm';
    }
    get requiresFilesystem() { return true; }

    get interactive() {
        const isHelpOrVersion = (this.arguments || []).some(a => a === '--help' || a === '-h' || a === '--version' || a === '-V' || a === '-v');
        if (isHelpOrVersion) return false;
        if (this._isInteractive !== undefined) return Boolean(this._isInteractive);
        const meta = this._ensurePkgMeta();
        if (meta && (meta.interactive || meta.wasm?.interactive)) return true;
        if (this._inspectedWasm && this._inspectedWasm.isInteractive) return true;
        return false;
    }

    get captureInput() {
        return this.interactive;
    }

    get isRaw() {
        if (typeof this._getTermiosLflag === 'function') {
            try {
                const raw = ((this._getTermiosLflag() >>> 0) & TERMIOS_ISIG) === 0;
                if (this._inAltScreen && this.stdinStream && typeof this.stdinStream.setRawMode === 'function' && this.stdinStream.isRaw !== raw) {
                    this.stdinStream.setRawMode(raw);
                }
                return raw;
            } catch (_) {}
        }
        const meta = this._ensurePkgMeta();
        if (meta && (meta.raw !== undefined || meta.wasm?.raw !== undefined)) {
            return Boolean(meta.raw ?? meta.wasm?.raw);
        }
        return Boolean(this.stdinStream && this.stdinStream.isRaw);
    }

    _syncRawMode() {
        if (!this.stdinStream || typeof this.stdinStream.setRawMode !== 'function') return;
        if (!this._inAltScreen && !this._isInteractive) {
            if (this.stdinStream.isRaw) this.stdinStream.setRawMode(false);
            return;
        }
        if (typeof this._getTermiosLflag === 'function') {
            try {
                const raw = ((this._getTermiosLflag() >>> 0) & TERMIOS_ISIG) === 0;
                this.stdinStream.setRawMode(raw);
                return;
            } catch (_) {}
        }
        const meta = this._ensurePkgMeta();
        if (meta && (meta.raw !== undefined || meta.wasm?.raw !== undefined)) {
            this.stdinStream.setRawMode(Boolean(meta.raw ?? meta.wasm?.raw));
            return;
        }
        this.stdinStream.setRawMode(false);
    }

    kill(signal = 'SIGINT') {
        this._killed = true;
        this.exitCode = 130;
        this._exitAltScreen();
        if (this._asyncifyReject) {
            try { this._asyncifyReject(new Error('Interrupted by SIGINT')); } catch (_) {}
            this._asyncifyReject = null;
        }
        if (this._pendingReadResolve) {
            const r = this._pendingReadResolve;
            this._pendingReadResolve = null;
            try { r(); } catch (_) {}
        }
        super.kill(signal);
    }

    _enterAltScreen() {
        if (this._inAltScreen) return;
        this._inAltScreen = true;
        this._syncRawMode();
        if (this.stdout && typeof this.stdout.write === 'function') {
            this.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
        }
    }

    _exitAltScreen() {
        if (!this._inAltScreen) return;
        this._inAltScreen = false;
        if (this.stdinStream && typeof this.stdinStream.setRawMode === 'function') {
            this.stdinStream.setRawMode(false);
        }
        if (this.stdout && typeof this.stdout.write === 'function') {
            this.stdout.write('\x1b[0m\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h');
        }
    }

    _keyToBytes(key) {
        if (!key) return null;
        if (typeof key !== 'string') {
            if (key instanceof Uint8Array) return key;
            return new Uint8Array([Number(key) & 0xff]);
        }
        if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Unidentified'].includes(key)) {
            return null;
        }
        const ctrlMatch = key.match(/^\^([A-Za-z@\[\\\]^_?])$/);
        if (ctrlMatch) {
            const ch = ctrlMatch[1].toUpperCase();
            if (ch === '?') return new Uint8Array([0x7f]);
            return new Uint8Array([ch.charCodeAt(0) - 64]);
        }
        const map = {
            'Enter': '\r',
            'Return': '\r',
            'Space': ' ',
            'Spacebar': ' ',
            'Backspace': '\x7f',
            'Tab': '\t',
            'BackTab': '\x1b[Z',
            'Escape': '\x1b',
            'Esc': '\x1b',
            'ArrowUp': '\x1b[A',
            'Up': '\x1b[A',
            'ArrowDown': '\x1b[B',
            'Down': '\x1b[B',
            'ArrowRight': '\x1b[C',
            'Right': '\x1b[C',
            'ArrowLeft': '\x1b[D',
            'Left': '\x1b[D',
            'Home': '\x1b[H',
            'End': '\x1b[F',
            'PageUp': '\x1b[5~',
            'PageDown': '\x1b[6~',
            'Delete': '\x1b[3~',
            'Del': '\x1b[3~',
            'Insert': '\x1b[2~',
            'F1': '\x1bOP',
            'F2': '\x1bOQ',
            'F3': '\x1bOR',
            'F4': '\x1bOS',
            'F5': '\x1b[15~',
            'F6': '\x1b[17~',
            'F7': '\x1b[18~',
            'F8': '\x1b[19~',
            'F9': '\x1b[20~',
            'F10': '\x1b[21~',
            'F11': '\x1b[23~',
            'F12': '\x1b[24~',
        };
        if (map[key]) return new TextEncoder().encode(map[key]);
        return new TextEncoder().encode(key);
    }

    onInput(key) {
        if (this._handlingStreamData) return;
        if (this.stdinStream && this.stdinStream._isPushing) {
            return;
        }
        if (typeof this._externalKeyHandler === 'function') {
            this._externalKeyHandler(key);
            return;
        }
        if (this.stdinStream && this.stdinStream.isRaw) {
            return;
        }
    }

    runCommand() {
        return super.runCommand().finally(() => {
            if (this._inAltScreen) {
                this._exitAltScreen();
            }
        });
    }

    run() {
        const filepath = this.script;
        const nodeFs = (() => { try { return require('fs'); } catch { return null; } })();

        return this._loadBytes(filepath, nodeFs)
            .then(({ bytes, isWat }) => {
                if (this.interactive) {
                    this.emit('interactive');
                    if (this.context && typeof this.context.emit === 'function') {
                        this.context.emit('interactive');
                    }
                }
                return isWat ? this._runWat(bytes) : this._runWasm(bytes);
            })
            .catch(e => {
                this.stdErr = e.message || String(e);
                this.exitCode = 1;
            });
    }

    _loadBytes(filepath, nodeFs) {
        const fs = (this.context && this.context.fs) || this.fs;
        if (!fs) return Promise.reject(new Error(`${filepath}: Filesystem is not available`));
        let p;
        if (fs.isRealFilesystem && nodeFs) {
            try {
                const buf = nodeFs.readFileSync(fs.absolutePath(filepath));
                const bytes = new Uint8Array(buf);
                p = Promise.resolve({ bytes, isWat: this._isWat(filepath, bytes) });
            } catch(e) {
                return Promise.reject(new Error(`${filepath}: ${e.message}`));
            }
        } else {
            const content = fs.getFileByPath(filepath);
            if (content == null) return Promise.reject(new Error(`${filepath}: No such file or directory`));
            const bytes = this._contentToBytes(content);
            p = Promise.resolve({ bytes, isWat: this._isWat(filepath, bytes) });
        }
        return p.then(res => {
            if (!res.isWat && res.bytes) {
                this._inspectedWasm = inspectWasmBytes(res.bytes);
                if (this._inspectedWasm.isInteractive) {
                    this._isInteractive = true;
                }
            }
            return res;
        });
    }

    _isWat(filepath, bytes) {
        if (filepath.endsWith('.wat')) return true;
        // WAT text starts with '(' (0x28); WASM binary starts with \0asm (0x00)
        return bytes.length > 0 && bytes[0] === 0x28;
    }

    _contentToBytes(content) {
        if (content instanceof Uint8Array) return content;
        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content))
            return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        if (content instanceof ArrayBuffer) return new Uint8Array(content);
        // Binary string stored in virtual filesystem
        const bytes = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
        return bytes;
    }

    async _runWat(bytes) {
        const text = new TextDecoder().decode(bytes);
        let wasmBytes;

        let wabtModule;
        try {
            const wabtPkg = 'wabt'; // variable prevents Vite static import analysis
            wabtModule = await import(/* @vite-ignore */wabtPkg);
        } catch(e) {
            this.stdErr = `${this.script}: WAT execution requires the 'wabt' package\nInstall it with: npm install wabt`;
            this.exitCode = 1;
            return;
        }

        try {
            const wabtInit = wabtModule.default ?? wabtModule;
            const wabt = typeof wabtInit === 'function' ? await wabtInit() : wabtInit;
            const parsed = wabt.parseWat(this.script, text, { mutable_globals: true });
            const { buffer } = parsed.toBinary({});
            wasmBytes = new Uint8Array(buffer);
        } catch(e) {
            this.stdErr = `${this.script}: WAT compilation error: ${e.message}`;
            this.exitCode = 1;
            return;
        }

        return this._runWasm(wasmBytes);
    }

    async _runWasm(bytes) {
        if (typeof WebAssembly === 'undefined') {
            this.stdErr = `${this.script}: WebAssembly is not available in this environment`;
            this.exitCode = 1;
            return;
        }

        const outBuf = { 1: '', 2: '' };
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let memRef = null;
        let instance = null;
        let hasAsyncify = false;
        let asyncifyDataAddr = 0;
        let asyncifyPromise = null;
        let pendingReadResolve = null;
        let pendingResizeInterrupt = null;
        let pollTimedOut = false;
        let pollInterrupted = false;
        let readInterrupted = false;
        let onStdoutResize = null;
        let onStdinResize = null;
        let onStreamData = null;

        const isTtyEnvironment = (this.stdin === undefined || this.stdin === null || this.stdin === this.stdinStream || (this.stdin && this.stdin.isTTY));

        let isInteractive = Boolean(
            this.interactive && isTtyEnvironment
        );

        if (isInteractive) {
            this.emit('interactive');
            if (this.context && typeof this.context.emit === 'function') {
                this.context.emit('interactive');
            }
        }

        const promoteToInteractive = () => {
            if (isInteractive || !isTtyEnvironment) return;
            isInteractive = true;
            this._isInteractive = true;
            this.emit('interactive');
            if (this.context && typeof this.context.emit === 'function') {
                this.context.emit('interactive');
            }

            this._enterAltScreen();

            if (outBuf[1]) {
                if (this.stdout && typeof this.stdout.write === 'function') this.stdout.write(outBuf[1]);
                outBuf[1] = '';
            }
            if (outBuf[2]) {
                if (this.stderr && typeof this.stderr.write === 'function') this.stderr.write(outBuf[2]);
                outBuf[2] = '';
            }

            this._syncRawMode();
        };

        const writeFd = (fd, text) => {
            if (isInteractive && (fd === 1 || fd === 2)) {
                if (fd === 1 && this.stdout) {
                    this.stdout.write(text);
                    return;
                }
                if (fd === 2 && this.stderr) {
                    this.stderr.write(text);
                    return;
                }
            }
            outBuf[fd] = (outBuf[fd] || '') + text;
            const lines = outBuf[fd].split('\n');
            outBuf[fd] = lines.pop();
            for (const line of lines) {
                if (fd === 1) this.stdOut = line;
                else this.stdErr = line;
            }
        };

        const flushFd = () => {
            if (outBuf[1]) {
                if (isInteractive && this.stdout) this.stdout.write(outBuf[1]);
                else this.stdOut = outBuf[1];
                outBuf[1] = '';
            }
            if (outBuf[2]) {
                if (isInteractive && this.stderr) this.stderr.write(outBuf[2]);
                else this.stdErr = outBuf[2];
                outBuf[2] = '';
            }
        };

        const inputQueue = [];

        const enqueueBytes = (b) => {
            if (!b || b.length === 0) return;
            const raw = this.isRaw;
            for (let i = 0; i < b.length; i++) {
                if (b[i] === 3 && !raw) {
                    this.kill('SIGINT');
                    return;
                }
                inputQueue.push(b[i]);
            }
            if (pendingReadResolve) {
                const r = pendingReadResolve;
                pendingReadResolve = null;
                r();
            }
        };

        onStreamData = (chunk) => {
            this._handlingStreamData = true;
            try {
                const b = typeof chunk === 'string'
                    ? encoder.encode(chunk)
                    : (chunk instanceof Uint8Array
                        ? chunk
                        : (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)
                            ? new Uint8Array(chunk)
                            : encoder.encode(String(chunk ?? ''))));
                enqueueBytes(b);
            } finally {
                this._handlingStreamData = false;
            }
        };

        this._externalKeyHandler = (key) => {
            if (this._handlingStreamData) return;
            const b = this._keyToBytes(key);
            if (b) enqueueBytes(b);
        };

        const hadDefaultStdinListener = Boolean(
            this._onStdinStreamData
            && this.stdinStream
            && typeof this.stdinStream.listeners === 'function'
            && this.stdinStream.listeners('data').includes(this._onStdinStreamData)
        );
        if (hadDefaultStdinListener && typeof this.stdinStream.off === 'function') {
            this.stdinStream.off('data', this._onStdinStreamData);
        }
        if (isTtyEnvironment && this.stdinStream && typeof this.stdinStream.on === 'function') {
            this.stdinStream.on('data', onStreamData);
        }
        if (isTtyEnvironment && this.stdin && this.stdin !== this.stdinStream && typeof this.stdin.on === 'function') {
            this.stdin.on('data', onStreamData);
        }

        const stdinBytes = (!isTtyEnvironment && typeof this.stdin === 'string')
            ? encoder.encode(this.stdin)
            : (!isTtyEnvironment && this.stdin instanceof Uint8Array
                ? this.stdin
                : (!isTtyEnvironment && typeof Buffer !== 'undefined' && Buffer.isBuffer(this.stdin) ? new Uint8Array(this.stdin) : new Uint8Array(0)));
        let stdinPos = 0;

        // ── Virtual WASI file descriptor table backed by this.context.fs ──
        // fd 0: stdin, fd 1: stdout, fd 2: stderr
        // fd 3: pre-opened root directory '/'
        // fd 4: pre-opened current working directory '.'
        const fs = this.context && this.context.fs ? this.context.fs : this.fs;
        const rawCwd = (this.context && this.context.fs && this.context.fs.cwd)
            || (this.fs && this.fs.cwd)
            || (this.context && typeof this.context.getVar === 'function' && this.context.getVar('PWD'))
            || (fs && fs.cwd)
            || '/';
        const cwd = rawCwd.length > 1 && rawCwd.endsWith('/') ? rawCwd.slice(0, -1) : rawCwd;
        let nextFd = 5;
        const fdTable = new Map([
            [3, { type: 'preopen', path: '/', guestName: '/' }],
            [4, { type: 'preopen', path: cwd, guestName: '.' }]
        ]);
        const fdFlagsMap = new Map([[0, 0], [1, 0], [2, 0]]);

        const getParentPath = (p) => {
            const parts = p.split('/').filter(Boolean);
            parts.pop();
            return '/' + parts.join('/');
        };

        const resolveGuestPath = (dirFd, relPath) => {
            const dirEntry = fdTable.get(dirFd);
            if (!dirEntry || (dirEntry.type !== 'preopen' && dirEntry.type !== 'dir')) return null;
            if (relPath.startsWith('/')) return fs.absolutePath(relPath);
            if (!relPath || relPath === '.') return fs.absolutePath(dirEntry.path);

            const base = dirEntry.path.endsWith('/') ? dirEntry.path : dirEntry.path + '/';
            const directPath = fs.absolutePath(base + relPath);
            const rootPath = fs.absolutePath('/' + relPath);

            // If dirEntry is not '/', wasi-libc may have stripped the leading '/'
            // from an absolute path (e.g. 'root/ansitest.js' or 'etc/hosts')
            if (dirEntry.path !== '/') {
                if (fs.exists(directPath)) return directPath;
                if (fs.exists(rootPath)) return rootPath;

                // When file doesn't exist yet (e.g. creating new file), check parent directories
                const directParent = fs.exists(getParentPath(directPath));
                const rootParent = fs.exists(getParentPath(rootPath));
                if (rootParent && !directParent) return rootPath;
                if (directParent && !rootParent) return directPath;

                return directPath;
            }

            // dirEntry.path is '/'
            if (fs.exists(directPath)) return directPath;
            const cwdCandidate = fs.absolutePath(relPath);
            if (fs.exists(cwdCandidate)) return cwdCandidate;

            return directPath;
        };

        const flushOpenFile = (entry) => {
            if (!entry || entry.type !== 'file' || !entry.dirty || !fs) return;
            try {
                // Check if bytes are valid UTF-8 text without null bytes
                let isText = true;
                for (let i = 0; i < entry.bytes.length; i++) {
                    if (entry.bytes[i] === 0) { isText = false; break; }
                }
                if (isText) {
                    const str = decoder.decode(entry.bytes);
                    fs.setFileByPath(entry.path, str, true);
                } else {
                    const copy = new Uint8Array(entry.bytes.length);
                    copy.set(entry.bytes);
                    fs.setFileByPath(entry.path, new BinaryFile(copy.buffer, 'application/octet-stream'), true);
                }
                entry.dirty = false;
            } catch {
                // ignore write errors on close
            }
        };

        // Environment variables from context.vars with live terminal dimensions taking precedence
        const initCols = (this.stdout && this.stdout.columns)
            || (this.stdinStream && this.stdinStream.columns)
            || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('COLUMNS'), 10))
            || 80;
        const initRows = (this.stdout && this.stdout.rows)
            || (this.stdinStream && this.stdinStream.rows)
            || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('LINES'), 10))
            || 24;
        const termVars = {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            ...((this.context && this.context.vars) || {}),
            COLUMNS: String(initCols),
            LINES: String(initRows)
        };
        const envPairs = Object.entries(termVars).map(([k, v]) => `${k}=${v}`);

        const wasi = {
            fd_write: (fd, iovs, iovs_len, nwritten_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const view = new DataView(memRef.buffer);

                if (fd === 1 || fd === 2) {
                    let total = 0;
                    for (let i = 0; i < iovs_len; i++) {
                        const ptr = view.getUint32(iovs + i * 8, true);
                        const len = view.getUint32(iovs + i * 8 + 4, true);
                        if (len > 0) writeFd(fd, decoder.decode(new Uint8Array(memRef.buffer, ptr, len)));
                        total += len;
                    }
                    view.setUint32(nwritten_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                const entry = fdTable.get(fd);
                if (!entry) return ERRNO_BADF;

                if (entry.type === 'dev_null' || entry.type === 'dev_zero') {
                    let total = 0;
                    for (let i = 0; i < iovs_len; i++) {
                        total += view.getUint32(iovs + i * 8 + 4, true);
                    }
                    view.setUint32(nwritten_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                if (entry.type === 'dev_tty') {
                    let total = 0;
                    for (let i = 0; i < iovs_len; i++) {
                        const ptr = view.getUint32(iovs + i * 8, true);
                        const len = view.getUint32(iovs + i * 8 + 4, true);
                        if (len > 0) writeFd(1, decoder.decode(new Uint8Array(memRef.buffer, ptr, len)));
                        total += len;
                    }
                    view.setUint32(nwritten_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                if (entry.type !== 'file') return ERRNO_BADF;

                let total = 0;
                for (let i = 0; i < iovs_len; i++) {
                    const ptr = view.getUint32(iovs + i * 8, true);
                    const len = view.getUint32(iovs + i * 8 + 4, true);
                    if (len > 0) {
                        const chunk = new Uint8Array(memRef.buffer, ptr, len);
                        const writePos = entry.append ? entry.bytes.length : entry.pos;
                        const needed = writePos + len;
                        if (needed > entry.bytes.length) {
                            const grown = new Uint8Array(needed);
                            grown.set(entry.bytes);
                            entry.bytes = grown;
                        }
                        entry.bytes.set(chunk, writePos);
                        entry.pos = writePos + len;
                        entry.dirty = true;
                        total += len;
                    }
                }
                view.setUint32(nwritten_ptr, total, true);
                return ERRNO_SUCCESS;
            },
            fd_read: (fd, iovs, iovs_len, nread_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const view = new DataView(memRef.buffer);

                const entry = fdTable.get(fd);
                const isDevTty = Boolean(entry && entry.type === 'dev_tty');
                const isTtyInput = (fd === 0) || (isInteractive && fd === 2) || isDevTty;

                if (isTtyInput) {
                    if (isDevTty || fd === 2) {
                        promoteToInteractive();
                    }
                    this._syncRawMode();
                    const flags = fdFlagsMap.get(fd) || 0;
                    const isNonBlocking = Boolean(flags & FDFLAGS_NONBLOCK);

                    if (hasAsyncify) {
                        const state = (typeof instance?.exports?.asyncify_get_state === 'function')
                            ? instance.exports.asyncify_get_state()
                            : 0;

                        if (state === 2) {
                            instance.exports.asyncify_stop_rewind();
                            if (readInterrupted && inputQueue.length === 0) {
                                readInterrupted = false;
                                view.setUint32(nread_ptr, 0, true);
                                return ERRNO_INTR;
                            }
                            readInterrupted = false;
                            let total = 0;
                            for (let i = 0; i < iovs_len && inputQueue.length > 0; i++) {
                                const ptr = view.getUint32(iovs + i * 8, true);
                                const len = view.getUint32(iovs + i * 8 + 4, true);
                                const chunk = Math.min(len, inputQueue.length);
                                const slice = inputQueue.splice(0, chunk);
                                new Uint8Array(memRef.buffer).set(slice, ptr);
                                total += chunk;
                            }
                            view.setUint32(nread_ptr, total, true);
                            return ERRNO_SUCCESS;
                        }

                        if (inputQueue.length > 0) {
                            let total = 0;
                            for (let i = 0; i < iovs_len && inputQueue.length > 0; i++) {
                                const ptr = view.getUint32(iovs + i * 8, true);
                                const len = view.getUint32(iovs + i * 8 + 4, true);
                                const chunk = Math.min(len, inputQueue.length);
                                const slice = inputQueue.splice(0, chunk);
                                new Uint8Array(memRef.buffer).set(slice, ptr);
                                total += chunk;
                            }
                            view.setUint32(nread_ptr, total, true);
                            return ERRNO_SUCCESS;
                        }

                        if (isNonBlocking) {
                            view.setUint32(nread_ptr, 0, true);
                            return ERRNO_AGAIN;
                        }

                        readInterrupted = false;
                        instance.exports.asyncify_start_unwind(asyncifyDataAddr);
                        asyncifyPromise = new Promise((resolve, reject) => {
                            const onReadReady = () => {
                                readInterrupted = false;
                                pendingReadResolve = null;
                                pendingResizeInterrupt = null;
                                this._pendingReadResolve = null;
                                this._asyncifyReject = null;
                                resolve();
                            };
                            pendingReadResolve = onReadReady;
                            this._pendingReadResolve = onReadReady;
                            pendingResizeInterrupt = () => {
                                readInterrupted = true;
                                pendingReadResolve = null;
                                pendingResizeInterrupt = null;
                                this._pendingReadResolve = null;
                                this._asyncifyReject = null;
                                resolve();
                            };
                            this._asyncifyReject = reject;
                        });
                        view.setUint32(nread_ptr, 0, true);
                        return ERRNO_SUCCESS;
                    }

                    if (inputQueue.length > 0) {
                        let total = 0;
                        for (let i = 0; i < iovs_len && inputQueue.length > 0; i++) {
                            const ptr = view.getUint32(iovs + i * 8, true);
                            const len = view.getUint32(iovs + i * 8 + 4, true);
                            const chunk = Math.min(len, inputQueue.length);
                            const slice = inputQueue.splice(0, chunk);
                            new Uint8Array(memRef.buffer).set(slice, ptr);
                            total += chunk;
                        }
                        view.setUint32(nread_ptr, total, true);
                        return ERRNO_SUCCESS;
                    }

                    let total = 0;
                    for (let i = 0; i < iovs_len && stdinPos < stdinBytes.length; i++) {
                        const ptr = view.getUint32(iovs + i * 8, true);
                        const len = view.getUint32(iovs + i * 8 + 4, true);
                        const chunk = Math.min(len, stdinBytes.length - stdinPos);
                        new Uint8Array(memRef.buffer).set(stdinBytes.slice(stdinPos, stdinPos + chunk), ptr);
                        stdinPos += chunk;
                        total += chunk;
                    }
                    if (total === 0 && isNonBlocking && stdinPos >= stdinBytes.length) {
                        view.setUint32(nread_ptr, 0, true);
                        return ERRNO_AGAIN;
                    }
                    view.setUint32(nread_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                if (!entry) return ERRNO_BADF;

                if (entry.type === 'dev_null') {
                    view.setUint32(nread_ptr, 0, true);
                    return ERRNO_SUCCESS;
                }

                if (entry.type === 'dev_zero') {
                    let total = 0;
                    for (let i = 0; i < iovs_len; i++) {
                        const ptr = view.getUint32(iovs + i * 8, true);
                        const len = view.getUint32(iovs + i * 8 + 4, true);
                        new Uint8Array(memRef.buffer, ptr, len).fill(0);
                        total += len;
                    }
                    view.setUint32(nread_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                if (entry.type === 'dev_urandom') {
                    let total = 0;
                    for (let i = 0; i < iovs_len; i++) {
                        const ptr = view.getUint32(iovs + i * 8, true);
                        const len = view.getUint32(iovs + i * 8 + 4, true);
                        const targetBuf = new Uint8Array(memRef.buffer, ptr, len);
                        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
                            crypto.getRandomValues(targetBuf);
                        } else {
                            for (let j = 0; j < len; j++) targetBuf[j] = Math.floor(Math.random() * 256);
                        }
                        total += len;
                    }
                    view.setUint32(nread_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                if (entry.type !== 'file') return ERRNO_BADF;

                let total = 0;
                for (let i = 0; i < iovs_len && entry.pos < entry.bytes.length; i++) {
                    const ptr = view.getUint32(iovs + i * 8, true);
                    const len = view.getUint32(iovs + i * 8 + 4, true);
                    const chunk = Math.min(len, entry.bytes.length - entry.pos);
                    new Uint8Array(memRef.buffer).set(entry.bytes.subarray(entry.pos, entry.pos + chunk), ptr);
                    entry.pos += chunk;
                    total += chunk;
                }
                view.setUint32(nread_ptr, total, true);
                return ERRNO_SUCCESS;
            },
            fd_seek: (fd, offset_low, offset_high, whence, newoffset_ptr) => {
                if (!memRef) return ERRNO_BADF;
                if (fd <= 2) return ERRNO_SPIPE;
                const entry = fdTable.get(fd);
                if (!entry) return ERRNO_BADF;
                if (entry.type === 'dev_tty' || entry.type === 'dev_null' || entry.type === 'dev_zero' || entry.type === 'dev_urandom') {
                    return ERRNO_SPIPE;
                }
                if (entry.type !== 'file') return ERRNO_BADF;

                // Support both BigInt (i64) and split 32-bit calls
                let off;
                let wh;
                let outPtr;
                if (typeof offset_low === 'bigint') {
                    off = Number(offset_low);
                    wh = offset_high;
                    outPtr = whence;
                } else {
                    off = offset_low;
                    wh = whence;
                    outPtr = newoffset_ptr;
                }

                let target = entry.pos;
                if (wh === 0) target = off; // SEEK_SET
                else if (wh === 1) target = entry.pos + off; // SEEK_CUR
                else if (wh === 2) target = entry.bytes.length + off; // SEEK_END
                else return ERRNO_INVAL;

                if (target < 0) return ERRNO_INVAL;
                entry.pos = target;
                if (outPtr) {
                    new DataView(memRef.buffer).setBigUint64(outPtr, BigInt(entry.pos), true);
                }
                return ERRNO_SUCCESS;
            },
            fd_tell: (fd, offset_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const entry = fdTable.get(fd);
                if (!entry || entry.type !== 'file') return ERRNO_BADF;
                new DataView(memRef.buffer).setBigUint64(offset_ptr, BigInt(entry.pos), true);
                return ERRNO_SUCCESS;
            },
            fd_close: (fd) => {
                if (fd <= 2) return ERRNO_SUCCESS;
                const entry = fdTable.get(fd);
                if (!entry) return ERRNO_BADF;
                if (entry.type === 'file') flushOpenFile(entry);
                fdTable.delete(fd);
                fdFlagsMap.delete(fd);
                return ERRNO_SUCCESS;
            },
            fd_sync: (fd) => {
                const entry = fdTable.get(fd);
                if (entry) flushOpenFile(entry);
                return ERRNO_SUCCESS;
            },
            fd_datasync: (fd) => {
                const entry = fdTable.get(fd);
                if (entry) flushOpenFile(entry);
                return ERRNO_SUCCESS;
            },
            fd_prestat_get: (fd, buf_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const entry = fdTable.get(fd);
                if (!entry || entry.type !== 'preopen') return ERRNO_BADF;
                const view = new DataView(memRef.buffer);
                const nameBytes = encoder.encode(entry.guestName);
                view.setUint8(buf_ptr, 0); // PREOPENTYPE_DIR
                view.setUint32(buf_ptr + 4, nameBytes.length, true);
                return ERRNO_SUCCESS;
            },
            fd_prestat_dir_name: (fd, path_ptr, path_len) => {
                if (!memRef) return ERRNO_BADF;
                const entry = fdTable.get(fd);
                if (!entry || entry.type !== 'preopen') return ERRNO_BADF;
                const nameBytes = encoder.encode(entry.guestName);
                new Uint8Array(memRef.buffer, path_ptr, Math.min(path_len, nameBytes.length))
                    .set(nameBytes.subarray(0, path_len));
                return ERRNO_SUCCESS;
            },
            fd_fdstat_get: (fd, stat_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const view = new DataView(memRef.buffer);
                let filetype = FILETYPE_UNKNOWN;
                if (fd <= 2) {
                    filetype = FILETYPE_CHARACTER_DEVICE;
                } else {
                    const entry = fdTable.get(fd);
                    if (!entry) return ERRNO_BADF;
                    if (entry.type === 'dev_null' || entry.type === 'dev_zero' || entry.type === 'dev_urandom' || entry.type === 'dev_tty') {
                        filetype = FILETYPE_CHARACTER_DEVICE;
                    } else {
                        filetype = (entry.type === 'preopen' || entry.type === 'dir')
                            ? FILETYPE_DIRECTORY
                            : FILETYPE_REGULAR_FILE;
                    }
                }
                // struct fdstat (24 bytes): fs_filetype (u8), fs_flags (u16), rights_base (u64), rights_inheriting (u64)
                for (let i = 0; i < 24; i++) view.setUint8(stat_ptr + i, 0);
                view.setUint8(stat_ptr, filetype);
                const flags = fdFlagsMap.get(fd) || (fdTable.get(fd)?.append ? FDFLAGS_APPEND : 0);
                view.setUint16(stat_ptr + 2, flags, true);
                view.setBigUint64(stat_ptr + 8, 0xffffffffffffffffn, true);
                view.setBigUint64(stat_ptr + 16, 0xffffffffffffffffn, true);
                return ERRNO_SUCCESS;
            },
            fd_fdstat_set_flags: (fd, flags) => {
                if (!memRef) return ERRNO_BADF;
                if (fd > 2 && !fdTable.has(fd)) return ERRNO_BADF;
                fdFlagsMap.set(fd, flags);
                const entry = fdTable.get(fd);
                if (entry) {
                    entry.append = Boolean(flags & FDFLAGS_APPEND);
                }
                if ((fd === 0 || fd === 2 || (entry && entry.type === 'dev_tty')) && (flags & FDFLAGS_NONBLOCK)) {
                    promoteToInteractive();
                }
                return ERRNO_SUCCESS;
            },
            fd_filestat_get: (fd, buf_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const view = new DataView(memRef.buffer);
                for (let i = 0; i < 64; i++) view.setUint8(buf_ptr + i, 0);
                if (fd <= 2) {
                    view.setUint8(buf_ptr + 16, FILETYPE_CHARACTER_DEVICE);
                    return ERRNO_SUCCESS;
                }
                const entry = fdTable.get(fd);
                if (!entry) return ERRNO_BADF;
                if (entry.type === 'dev_null' || entry.type === 'dev_zero' || entry.type === 'dev_urandom' || entry.type === 'dev_tty') {
                    view.setUint8(buf_ptr + 16, FILETYPE_CHARACTER_DEVICE);
                    view.setBigUint64(buf_ptr + 24, 1n, true); // nlink
                    return ERRNO_SUCCESS;
                }
                const isDir = entry.type === 'preopen' || entry.type === 'dir';
                view.setUint8(buf_ptr + 16, isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
                view.setBigUint64(buf_ptr + 24, 1n, true); // nlink
                view.setBigUint64(buf_ptr + 32, BigInt(entry.bytes ? entry.bytes.length : 0), true);
                return ERRNO_SUCCESS;
            },
            path_open: (dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inh, fdflags, opened_fd_ptr) => {
                if (!memRef || !fs) return ERRNO_BADF;
                const relPath = decoder.decode(new Uint8Array(memRef.buffer, path_ptr, path_len));
                const absPath = resolveGuestPath(dirfd, relPath);
                if (!absPath) return ERRNO_BADF;

                const cleanPath = absPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
                if (cleanPath === '/dev/null') {
                    const newFd = nextFd++;
                    fdTable.set(newFd, { type: 'dev_null', path: '/dev/null' });
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, newFd, true);
                    return ERRNO_SUCCESS;
                }
                if (cleanPath === '/dev/zero') {
                    const newFd = nextFd++;
                    fdTable.set(newFd, { type: 'dev_zero', path: '/dev/zero' });
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, newFd, true);
                    return ERRNO_SUCCESS;
                }
                if (cleanPath === '/dev/urandom' || cleanPath === '/dev/random') {
                    const newFd = nextFd++;
                    fdTable.set(newFd, { type: 'dev_urandom', path: cleanPath });
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, newFd, true);
                    return ERRNO_SUCCESS;
                }
                if (cleanPath === '/dev/tty' || cleanPath === '/dev/stdin') {
                    promoteToInteractive();
                    const newFd = nextFd++;
                    fdTable.set(newFd, { type: 'dev_tty', path: cleanPath });
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, newFd, true);
                    return ERRNO_SUCCESS;
                }
                if (cleanPath === '/dev/stdout') {
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, 1, true);
                    return ERRNO_SUCCESS;
                }
                if (cleanPath === '/dev/stderr') {
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, 2, true);
                    return ERRNO_SUCCESS;
                }

                const st = fs.stat(absPath);
                const exists = st !== null;

                if ((oflags & OFLAGS_EXCL) && (oflags & OFLAGS_CREAT) && exists) {
                    return ERRNO_EXIST;
                }
                if ((oflags & OFLAGS_DIRECTORY)) {
                    if (!exists) return ERRNO_NOENT;
                    if (!st.isDirectory) return ERRNO_NOTDIR;
                    const newFd = nextFd++;
                    fdTable.set(newFd, { type: 'dir', path: absPath });
                    new DataView(memRef.buffer).setUint32(opened_fd_ptr, newFd, true);
                    return ERRNO_SUCCESS;
                }

                if (exists && st.isDirectory) {
                    return ERRNO_ISDIR;
                }
                if (!exists && !(oflags & OFLAGS_CREAT)) {
                    return ERRNO_NOENT;
                }

                let initialBytes = new Uint8Array(0);
                let dirty = false;
                if (exists && !(oflags & OFLAGS_TRUNC)) {
                    const content = fs.getFileByPath(absPath);
                    if (content !== null && content !== undefined) {
                        initialBytes = typeof content === 'string'
                            ? encoder.encode(content)
                            : new Uint8Array(this._contentToBytes(content));
                    }
                } else {
                    dirty = true;
                }

                const newFd = nextFd++;
                fdTable.set(newFd, {
                    type: 'file',
                    path: absPath,
                    bytes: initialBytes,
                    pos: (fdflags & FDFLAGS_APPEND) ? initialBytes.length : 0,
                    append: Boolean(fdflags & FDFLAGS_APPEND),
                    dirty
                });
                new DataView(memRef.buffer).setUint32(opened_fd_ptr, newFd, true);
                return ERRNO_SUCCESS;
            },
            path_filestat_get: (dirfd, flags, path_ptr, path_len, buf_ptr) => {
                if (!memRef || !fs) return ERRNO_BADF;
                const relPath = decoder.decode(new Uint8Array(memRef.buffer, path_ptr, path_len));
                const absPath = resolveGuestPath(dirfd, relPath);
                if (!absPath) return ERRNO_BADF;
                const cleanPath = absPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
                const st = fs.stat(absPath);
                if (cleanPath === '/dev/null' || cleanPath === '/dev/zero' || cleanPath === '/dev/urandom' || cleanPath === '/dev/random' || cleanPath === '/dev/tty' || cleanPath === '/dev/stdin' || cleanPath === '/dev/stdout' || cleanPath === '/dev/stderr' || (st && (st.isDevice || st.isCharacterDevice))) {
                    const view = new DataView(memRef.buffer);
                    for (let i = 0; i < 64; i++) view.setUint8(buf_ptr + i, 0);
                    view.setUint8(buf_ptr + 16, FILETYPE_CHARACTER_DEVICE);
                    view.setBigUint64(buf_ptr + 24, 1n, true);
                    return ERRNO_SUCCESS;
                }
                if (!st) return ERRNO_NOENT;
                const view = new DataView(memRef.buffer);
                for (let i = 0; i < 64; i++) view.setUint8(buf_ptr + i, 0);
                view.setUint8(buf_ptr + 16, st.isDirectory ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
                view.setBigUint64(buf_ptr + 24, 1n, true);
                view.setBigUint64(buf_ptr + 32, BigInt(fs.getSize(absPath) || 0), true);
                return ERRNO_SUCCESS;
            },
            path_create_directory: (dirfd, path_ptr, path_len) => {
                if (!memRef || !fs) return ERRNO_BADF;
                const relPath = decoder.decode(new Uint8Array(memRef.buffer, path_ptr, path_len));
                const absPath = resolveGuestPath(dirfd, relPath);
                if (!absPath) return ERRNO_BADF;
                if (fs.exists(absPath)) return ERRNO_EXIST;
                try {
                    fs.setFileByPath(absPath, {}, true);
                    return ERRNO_SUCCESS;
                } catch {
                    return ERRNO_INVAL;
                }
            },
            path_unlink_file: (dirfd, path_ptr, path_len) => {
                if (!memRef || !fs) return ERRNO_BADF;
                const relPath = decoder.decode(new Uint8Array(memRef.buffer, path_ptr, path_len));
                const absPath = resolveGuestPath(dirfd, relPath);
                if (!absPath || !fs.exists(absPath)) return ERRNO_NOENT;
                try {
                    fs.deleteFileByPath(absPath);
                    return ERRNO_SUCCESS;
                } catch {
                    return ERRNO_INVAL;
                }
            },
            path_remove_directory: (dirfd, path_ptr, path_len) => {
                if (!memRef || !fs) return ERRNO_BADF;
                const relPath = decoder.decode(new Uint8Array(memRef.buffer, path_ptr, path_len));
                const absPath = resolveGuestPath(dirfd, relPath);
                if (!absPath || !fs.exists(absPath)) return ERRNO_NOENT;
                try {
                    fs.deleteFileByPath(absPath);
                    return ERRNO_SUCCESS;
                } catch {
                    return ERRNO_INVAL;
                }
            },
            path_rename: (old_dirfd, old_path_ptr, old_path_len, new_dirfd, new_path_ptr, new_path_len) => {
                if (!memRef || !fs) return ERRNO_BADF;
                const oldRel = decoder.decode(new Uint8Array(memRef.buffer, old_path_ptr, old_path_len));
                const newRel = decoder.decode(new Uint8Array(memRef.buffer, new_path_ptr, new_path_len));
                const oldAbs = resolveGuestPath(old_dirfd, oldRel);
                const newAbs = resolveGuestPath(new_dirfd, newRel);
                if (!oldAbs || !newAbs) return ERRNO_BADF;
                if (!fs.exists(oldAbs)) return ERRNO_NOENT;

                for (const entry of fdTable.values()) {
                    if (entry.path === oldAbs) {
                        flushOpenFile(entry);
                        entry.path = newAbs;
                    }
                }

                try {
                    const content = fs.getFileByPath(oldAbs);
                    fs.setFileByPath(newAbs, content, true);
                    fs.deleteFileByPath(oldAbs);
                    return ERRNO_SUCCESS;
                } catch {
                    return ERRNO_INVAL;
                }
            },
            proc_exit: (code) => {
                if (code !== 0) this.exitCode = code;
                throw { _wasmExit: true, code };
            },
            args_sizes_get: (argc_ptr, buf_size_ptr) => {
                if (!memRef) return ERRNO_INVAL;
                const args = [this.script, ...(this.arguments || [])];
                const view = new DataView(memRef.buffer);
                view.setUint32(argc_ptr, args.length, true);
                view.setUint32(buf_size_ptr, args.reduce((s, a) => s + encoder.encode(a).length + 1, 0), true);
                return ERRNO_SUCCESS;
            },
            args_get: (argv_ptr, buf_ptr) => {
                if (!memRef) return ERRNO_INVAL;
                const args = [this.script, ...(this.arguments || [])];
                const view = new DataView(memRef.buffer);
                let offset = buf_ptr;
                for (let i = 0; i < args.length; i++) {
                    view.setUint32(argv_ptr + i * 4, offset, true);
                    const encoded = encoder.encode(args[i] + '\0');
                    new Uint8Array(memRef.buffer).set(encoded, offset);
                    offset += encoded.length;
                }
                return ERRNO_SUCCESS;
            },
            environ_sizes_get: (cnt_ptr, sz_ptr) => {
                if (!memRef) return ERRNO_INVAL;
                const view = new DataView(memRef.buffer);
                view.setUint32(cnt_ptr, envPairs.length, true);
                const totalBytes = envPairs.reduce((s, p) => s + encoder.encode(p).length + 1, 0);
                view.setUint32(sz_ptr, totalBytes, true);
                return ERRNO_SUCCESS;
            },
            environ_get: (environ_ptr, environ_buf_ptr) => {
                if (!memRef) return ERRNO_INVAL;
                const view = new DataView(memRef.buffer);
                let offset = environ_buf_ptr;
                for (let i = 0; i < envPairs.length; i++) {
                    view.setUint32(environ_ptr + i * 4, offset, true);
                    const encoded = encoder.encode(envPairs[i] + '\0');
                    new Uint8Array(memRef.buffer).set(encoded, offset);
                    offset += encoded.length;
                }
                return ERRNO_SUCCESS;
            },
            clock_time_get: (id, prec, time_ptr) => {
                if (memRef) {
                    const ns = (id === 1 && typeof performance !== 'undefined' && typeof performance.now === 'function')
                        ? BigInt(Math.round(performance.now() * 1e6))
                        : BigInt(Date.now()) * 1_000_000n;
                    new DataView(memRef.buffer).setBigUint64(time_ptr, ns, true);
                }
                return ERRNO_SUCCESS;
            },
            random_get: (buf_ptr, buf_len) => {
                if (memRef) {
                    const arr = new Uint8Array(memRef.buffer, buf_ptr, buf_len);
                    for (let i = 0; i < buf_len; i++) arr[i] = Math.random() * 256 | 0;
                }
                return ERRNO_SUCCESS;
            },
            clock_nanosleep: (id, flags, timeout_ptr, precision, rem_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const view = new DataView(memRef.buffer);
                const timeoutNs = view.getBigUint64(timeout_ptr, true);
                let sleepMs = 0;
                if (flags & 1) { // TIMER_ABSTIME
                    const nowNs = BigInt(Date.now()) * 1_000_000n;
                    sleepMs = timeoutNs > nowNs ? Number((timeoutNs - nowNs) / 1_000_000n) : 0;
                } else {
                    sleepMs = Number(timeoutNs / 1_000_000n);
                }

                if (hasAsyncify && sleepMs > 0) {
                    const state = (typeof instance?.exports?.asyncify_get_state === 'function')
                        ? instance.exports.asyncify_get_state()
                        : 0;

                    if (state === 2) {
                        instance.exports.asyncify_stop_rewind();
                        return ERRNO_SUCCESS;
                    }

                    instance.exports.asyncify_start_unwind(asyncifyDataAddr);
                    asyncifyPromise = new Promise((resolve, reject) => {
                        const timer = setTimeout(() => {
                            this._asyncifyReject = null;
                            resolve();
                        }, Math.max(1, sleepMs));
                        this._asyncifyReject = (err) => {
                            clearTimeout(timer);
                            this._asyncifyReject = null;
                            reject(err);
                        };
                    });
                    return ERRNO_SUCCESS;
                }
                return ERRNO_SUCCESS;
            },
            poll_oneoff: (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
                if (!memRef) return ERRNO_BADF;
                const view = new DataView(memRef.buffer);
                this._syncRawMode();

                if (hasAsyncify) {
                    const state = (typeof instance?.exports?.asyncify_get_state === 'function')
                        ? instance.exports.asyncify_get_state()
                        : 0;

                    if (state === 2) {
                        instance.exports.asyncify_stop_rewind();
                        if (pollInterrupted && inputQueue.length === 0) {
                            pollInterrupted = false;
                            view.setUint32(nevents_ptr, 0, true);
                            return ERRNO_INTR;
                        }
                        pollInterrupted = false;
                        let nevents = 0;
                        for (let i = 0; i < nsubscriptions; i++) {
                            const subPtr = in_ptr + i * 48;
                            const userdata = view.getBigUint64(subPtr, true);
                            const type = view.getUint8(subPtr + 8);
                            let isReady = false;

                            if (type === 0) { // EVENTTYPE_CLOCK
                                isReady = pollTimedOut;
                            } else if (type === 1) { // EVENTTYPE_FD_READ
                                const fd = view.getUint32(subPtr + 16, true);
                                const entry = fdTable.get(fd);
                                const isDevTty = Boolean(entry && entry.type === 'dev_tty');
                                if ((fd === 0 || (isInteractive && fd === 2) || isDevTty) && inputQueue.length > 0) {
                                    isReady = true;
                                }
                            } else if (type === 2) { // EVENTTYPE_FD_WRITE
                                isReady = true;
                            }

                            if (isReady) {
                                const outEventPtr = out_ptr + nevents * 32;
                                view.setBigUint64(outEventPtr, userdata, true);
                                view.setUint16(outEventPtr + 8, ERRNO_SUCCESS, true);
                                view.setUint8(outEventPtr + 10, type);
                                for (let b = 11; b < 32; b++) view.setUint8(outEventPtr + b, 0);
                                if (type === 1) {
                                    view.setBigUint64(outEventPtr + 16, BigInt(inputQueue.length), true);
                                }
                                nevents++;
                            }
                        }
                        view.setUint32(nevents_ptr, nevents, true);
                        return ERRNO_SUCCESS;
                    }

                    let immediateCount = 0;
                    let hasFdReadSub = false;
                    let minTimeoutMs = Infinity;

                    for (let i = 0; i < nsubscriptions; i++) {
                        const subPtr = in_ptr + i * 48;
                        const type = view.getUint8(subPtr + 8);

                        if (type === 0) { // EVENTTYPE_CLOCK
                            const timeoutNs = view.getBigUint64(subPtr + 24, true);
                            const flags = view.getUint16(subPtr + 40, true);
                            let sleepMs = 0;
                            if (flags & 1) { // ABSTIME
                                const nowNs = BigInt(Date.now()) * 1_000_000n;
                                sleepMs = timeoutNs > nowNs ? Number((timeoutNs - nowNs) / 1_000_000n) : 0;
                            } else {
                                sleepMs = Number(timeoutNs / 1_000_000n);
                            }
                            if (sleepMs < minTimeoutMs) minTimeoutMs = sleepMs;
                        } else if (type === 1) { // EVENTTYPE_FD_READ
                            hasFdReadSub = true;
                            const fd = view.getUint32(subPtr + 16, true);
                            const entry = fdTable.get(fd);
                            const isDevTty = Boolean(entry && entry.type === 'dev_tty');
                            if (fd === 0 || fd === 2 || isDevTty) {
                                promoteToInteractive();
                            }
                            if ((fd === 0 || (isInteractive && fd === 2) || isDevTty) && inputQueue.length > 0) {
                                immediateCount++;
                            }
                        } else if (type === 2) { // EVENTTYPE_FD_WRITE
                            immediateCount++;
                        }
                    }

                    if (immediateCount > 0 || minTimeoutMs === 0) {
                        let nevents = 0;
                        for (let i = 0; i < nsubscriptions; i++) {
                            const subPtr = in_ptr + i * 48;
                            const userdata = view.getBigUint64(subPtr, true);
                            const type = view.getUint8(subPtr + 8);
                            let isReady = false;

                            if (type === 0 && minTimeoutMs === 0) isReady = true;
                            else if (type === 1) {
                                const fd = view.getUint32(subPtr + 16, true);
                                const entry = fdTable.get(fd);
                                const isDevTty = Boolean(entry && entry.type === 'dev_tty');
                                if ((fd === 0 || (isInteractive && fd === 2) || isDevTty) && inputQueue.length > 0) isReady = true;
                            } else if (type === 2) isReady = true;

                            if (isReady) {
                                const outEventPtr = out_ptr + nevents * 32;
                                view.setBigUint64(outEventPtr, userdata, true);
                                view.setUint16(outEventPtr + 8, ERRNO_SUCCESS, true);
                                view.setUint8(outEventPtr + 10, type);
                                for (let b = 11; b < 32; b++) view.setUint8(outEventPtr + b, 0);
                                if (type === 1) {
                                    view.setBigUint64(outEventPtr + 16, BigInt(inputQueue.length), true);
                                }
                                nevents++;
                            }
                        }
                        view.setUint32(nevents_ptr, nevents, true);
                        return ERRNO_SUCCESS;
                    }

                    pollTimedOut = false;
                    pollInterrupted = false;
                    instance.exports.asyncify_start_unwind(asyncifyDataAddr);
                    asyncifyPromise = new Promise((resolve, reject) => {
                        let timer = null;
                        this._asyncifyReject = (err) => {
                            if (timer) clearTimeout(timer);
                            pendingReadResolve = null;
                            pendingResizeInterrupt = null;
                            this._pendingReadResolve = null;
                            this._asyncifyReject = null;
                            reject(err);
                        };
                        const onKey = () => {
                            if (timer) clearTimeout(timer);
                            pollTimedOut = false;
                            pollInterrupted = false;
                            pendingReadResolve = null;
                            pendingResizeInterrupt = null;
                            this._pendingReadResolve = null;
                            this._asyncifyReject = null;
                            resolve();
                        };
                        if (hasFdReadSub) {
                            pendingReadResolve = onKey;
                            this._pendingReadResolve = onKey;
                            pendingResizeInterrupt = () => {
                                if (timer) clearTimeout(timer);
                                pollTimedOut = false;
                                pollInterrupted = true;
                                pendingReadResolve = null;
                                pendingResizeInterrupt = null;
                                this._pendingReadResolve = null;
                                this._asyncifyReject = null;
                                resolve();
                            };
                        }
                        if (minTimeoutMs !== Infinity) {
                            timer = setTimeout(() => {
                                pollTimedOut = true;
                                pollInterrupted = false;
                                pendingReadResolve = null;
                                pendingResizeInterrupt = null;
                                this._pendingReadResolve = null;
                                this._asyncifyReject = null;
                                resolve();
                            }, Math.max(1, minTimeoutMs));
                        }
                    });
                    view.setUint32(nevents_ptr, 0, true);
                    return ERRNO_SUCCESS;
                }

                view.setUint32(nevents_ptr, 0, true);
                return ERRNO_SUCCESS;
            },
        };

        const wasiProxy = new Proxy(wasi, { get(t, k) { return k in t ? t[k] : () => 0; } });

        // Helper for AssemblyScript UTF-16 managed strings (`ptr - 4` stores byte length)
        const readAsUtf16 = (ptr) => {
            if (!memRef || !ptr) return '';
            try {
                const view = new DataView(memRef.buffer);
                const byteLen = view.getUint32(ptr - 4, true);
                const u16 = new Uint16Array(memRef.buffer, ptr, byteLen >>> 1);
                return String.fromCharCode(...u16);
            } catch {
                return '';
            }
        };

        const imports = {
            wasi_snapshot_preview1: wasiProxy,
            wasi_unstable: wasiProxy,
            env: new Proxy({
                // Simple non-WASI & AssemblyScript imports
                print: (ptr, len) => { if (memRef) writeFd(1, decoder.decode(new Uint8Array(memRef.buffer, ptr, len))); },
                eprint: (ptr, len) => { if (memRef) writeFd(2, decoder.decode(new Uint8Array(memRef.buffer, ptr, len))); },
                log: (ptr) => { writeFd(1, readAsUtf16(ptr) + '\n'); },
                logi: (v) => { writeFd(1, String(v) + '\n'); },
                logf: (v) => { writeFd(1, String(v) + '\n'); },
                trace: (ptr, n, ...args) => {
                    const extra = n > 0 ? ' ' + args.slice(0, n).join(', ') : '';
                    writeFd(1, `trace: ${readAsUtf16(ptr)}${extra}\n`);
                },
                seed: () => Date.now() * Math.random(),
                abort: (msgPtr, filePtr, line, col) => {
                    const msg = readAsUtf16(msgPtr);
                    const file = readAsUtf16(filePtr);
                    if (msg || file) {
                        writeFd(2, `abort: ${msg || 'aborted'} at ${file || this.script}:${line || 0}:${col || 0}\n`);
                    }
                    this.exitCode = 134;
                    throw { _wasmExit: true, code: 134 };
                },
            }, { get(t, k) { return k in t ? t[k] : () => 0; } }),
        };

        try {
            const module = await WebAssembly.compile(bytes);

            // Satisfy any imported memory (some modules import rather than define it)
            for (const imp of WebAssembly.Module.imports(module)) {
                if (imp.kind === 'memory') {
                    const mem = new WebAssembly.Memory({ initial: 1, maximum: 256 });
                    memRef = mem;
                    if (!imports[imp.module]) imports[imp.module] = {};
                    imports[imp.module][imp.name] = mem;
                }
            }

            instance = await WebAssembly.instantiate(module, imports);

            // Prefer the module's own exported memory
            if (instance.exports.memory) memRef = instance.exports.memory;

            this._getTermiosLflag = typeof instance.exports.get_termios_lflag === 'function'
                ? instance.exports.get_termios_lflag
                : null;

            hasAsyncify = Boolean(instance.exports.asyncify_start_unwind && instance.exports.asyncify_stop_unwind);
            if (hasAsyncify && memRef) {
                try {
                    const prevPages = memRef.grow(1);
                    asyncifyDataAddr = prevPages * 65536;
                } catch {
                    asyncifyDataAddr = 16;
                }
                const dataStart = asyncifyDataAddr + 8;
                const dataEnd = asyncifyDataAddr + 65536 - 8;
                new Int32Array(memRef.buffer, asyncifyDataAddr, 2).set([dataStart, dataEnd]);
            }

            if (typeof instance.exports.set_terminal_size === 'function') {
                promoteToInteractive();
            }

            if (isInteractive) {
                this._enterAltScreen();
                this._syncRawMode();
            }

            const cols = (this.stdout && this.stdout.columns)
                || (this.stdinStream && this.stdinStream.columns)
                || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('COLUMNS'), 10))
                || 80;
            const rows = (this.stdout && this.stdout.rows)
                || (this.stdinStream && this.stdinStream.rows)
                || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('LINES'), 10))
                || 24;
            if (typeof instance.exports.set_terminal_size === 'function') {
                try { instance.exports.set_terminal_size(cols, rows); } catch {}
            }

            let lastAppliedCols = cols;
            let lastAppliedRows = rows;
            const applyResize = (c, r) => {
                if (!c || !r) return;
                if (this.stdout && (this.stdout.columns !== c || this.stdout.rows !== r)) {
                    this.stdout.columns = c;
                    this.stdout.rows = r;
                }
                if (this.stdinStream && (this.stdinStream.columns !== c || this.stdinStream.rows !== r)) {
                    this.stdinStream.columns = c;
                    this.stdinStream.rows = r;
                }
                if (this.context && typeof this.context.setVar === 'function') {
                    try {
                        this.context.setVar('COLUMNS', String(c));
                        this.context.setVar('LINES', String(r));
                    } catch {}
                }
                if (c === lastAppliedCols && r === lastAppliedRows) return;
                lastAppliedCols = c;
                lastAppliedRows = r;
                if (typeof instance?.exports?.set_terminal_size === 'function') {
                    try { instance.exports.set_terminal_size(c, r); } catch {}
                }
                if (pendingResizeInterrupt) {
                    const intr = pendingResizeInterrupt;
                    pendingResizeInterrupt = null;
                    intr();
                }
            };

            onStdoutResize = () => {
                const c = (this.stdout && this.stdout.columns) || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('COLUMNS'), 10)) || 80;
                const r = (this.stdout && this.stdout.rows) || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('LINES'), 10)) || 24;
                applyResize(c, r);
            };
            onStdinResize = () => {
                const c = (this.stdinStream && this.stdinStream.columns) || (this.stdout && this.stdout.columns) || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('COLUMNS'), 10)) || 80;
                const r = (this.stdinStream && this.stdinStream.rows) || (this.stdout && this.stdout.rows) || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('LINES'), 10)) || 24;
                applyResize(c, r);
            };
            if (this.stdout && typeof this.stdout.on === 'function') {
                this.stdout.on('resize', onStdoutResize);
            }
            if (this.stdinStream && this.stdinStream !== this.stdout && typeof this.stdinStream.on === 'function') {
                this.stdinStream.on('resize', onStdinResize);
            }

            const start = instance.exports._start
                || instance.exports.__wasi_command
                || instance.exports.main
                || instance.exports.run;

            if (!start) {
                const fnExports = Object.entries(instance.exports)
                    .filter(([, v]) => typeof v === 'function')
                    .map(([k]) => k);
                const exportHint = fnExports.length > 0
                    ? ` (module is a library exporting: ${fnExports.join(', ')})`
                    : '';
                this.stdErr = `${this.script}: no CLI entry point found (expected _start, main, or run)${exportHint}`;
                this.exitCode = 1;
            } else {
                try {
                    let res = start();
                    if (res && typeof res.then === 'function') res = await res;

                    while (hasAsyncify && typeof instance.exports.asyncify_get_state === 'function' && instance.exports.asyncify_get_state() === 1) {
                        if (this._killed) {
                            this.exitCode = 130;
                            break;
                        }
                        instance.exports.asyncify_stop_unwind();
                        if (asyncifyPromise) {
                            try {
                                await asyncifyPromise;
                            } catch (_) {
                                if (this._killed) {
                                    this.exitCode = 130;
                                    break;
                                }
                            }
                            asyncifyPromise = null;
                        }
                        if (this._killed) {
                            this.exitCode = 130;
                            break;
                        }
                        instance.exports.asyncify_start_rewind(asyncifyDataAddr);
                        res = start();
                        if (res && typeof res.then === 'function') res = await res;
                    }
                } catch(e) {
                    if (this._killed) {
                        this.exitCode = 130;
                    } else if (!e || !e._wasmExit) {
                        this.stdErr = `${this.script}: runtime error: ${e?.message || String(e)}`;
                        this.exitCode = 1;
                    }
                }
            }
        } catch(e) {
            if (this._killed) {
                this.exitCode = 130;
            } else if (!e || !e._wasmExit) {
                this.stdErr = `${this.script}: ${e?.message || String(e)}`;
                this.exitCode = 1;
            }
        } finally {
            if (isInteractive) {
                this._exitAltScreen();
            }
            if (onStreamData) {
                if (this.stdinStream && typeof this.stdinStream.off === 'function') this.stdinStream.off('data', onStreamData);
                if (this.stdin && typeof this.stdin.off === 'function') this.stdin.off('data', onStreamData);
            }
            if (hadDefaultStdinListener && this._onStdinStreamData && this.stdinStream && typeof this.stdinStream.on === 'function') {
                this.stdinStream.on('data', this._onStdinStreamData);
            }
            if (onStdoutResize && this.stdout && typeof this.stdout.off === 'function') {
                this.stdout.off('resize', onStdoutResize);
            }
            if (onStdinResize && this.stdinStream && typeof this.stdinStream.off === 'function') {
                this.stdinStream.off('resize', onStdinResize);
            }
            this._externalKeyHandler = null;
            this._getTermiosLflag = null;

            // Flush any open dirty WASI file descriptors back to the brsh filesystem
            for (const entry of fdTable.values()) {
                flushOpenFile(entry);
            }
        }

        flushFd();

        // Standard `--help` / `--version` fallback for raw WASI `.wasm` / `.wat` binaries
        // that do not inspect `argv` or print their own help/version output:
        // introspects the `.wasm` binary's data section and exports at runtime.
        const args = this.arguments || [];
        const hasOutput = this.result && this.result.getStdOutput && this.result.getStdOutput().length > 0;
        if (!hasOutput && (this.exitCode === 0 || this.exitCode === undefined)) {
            const pkgMeta = this._ensurePkgMeta();
            const binLabel = (pkgMeta && pkgMeta.bin) || (this.script || 'wasm').split('/').pop();
            const meta = Object.assign({
                name: (pkgMeta && pkgMeta.name) || binLabel,
                version: (pkgMeta && pkgMeta.version) || 'wasi',
                description: `WebAssembly WASI binary (${this.script})`
            }, pkgMeta || {});
            if (args.includes('--help') || args.includes('-h')) {
                const inspected = inspectWasmBytes(bytes);
                for (const line of formatWasmHelp(binLabel, meta, inspected)) {
                    this.stdOut = line;
                }
            } else if (args.includes('--version') || args.includes('-V') || args.includes('-v')) {
                this.stdOut = `${binLabel} (${meta.name} ${meta.version} wasm)`;
            }
        }
    }
}

// Shared cache of downloaded .wasm binaries across invocations
const wasmByteCache = new Map();

/**
 * Reads a file from the brsh filesystem as a Uint8Array (or null if missing).
 */
function readBytesFromFs(fs, filepath) {
    if (!fs || !fs.exists(filepath)) return null;
    if (fs.isRealFilesystem) {
        try {
            const nodeFs = require('fs');
            return new Uint8Array(nodeFs.readFileSync(fs.absolutePath(filepath)));
        } catch {
            // Fall through to virtual file map if stored in _virtualFiles
        }
    }
    const content = fs.getFileByPath(filepath);
    if (content == null) return null;
    if (content instanceof Uint8Array) {
        return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
        return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    if (content instanceof ArrayBuffer) {
        return new Uint8Array(content);
    }
    if (typeof content === 'string') {
        if (content.startsWith('data:')) {
            const comma = content.indexOf(',');
            if (comma !== -1) {
                const b64 = content.slice(comma + 1);
                if (typeof Buffer !== 'undefined') {
                    return new Uint8Array(Buffer.from(b64, 'base64'));
                }
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            }
        }
        const bytes = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) {
            bytes[i] = content.charCodeAt(i) & 0xff;
        }
        return bytes;
    }
    return null;
}

/**
 * Writes a Uint8Array to the brsh filesystem (as a BinaryFile on virtual FS, or Buffer on real FS).
 */
function writeBytesToFs(fs, filepath, bytes, mimeType = 'application/octet-stream') {
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (fs && fs.isRealFilesystem) {
        fs.setFileByPath(filepath, uint8, true);
        return;
    }
    const copy = new Uint8Array(uint8.byteLength);
    copy.set(uint8);
    const bf = new BinaryFile(copy.buffer, mimeType);
    if (typeof fs._setFileRaw === 'function' && filepath.startsWith('/var/lib/wbt/')) {
        fs._setFileRaw(filepath, bf, true);
        return;
    }
    fs.setFileByPath(filepath, bf, true);
}

/**
 * Dynamically imports a WASM/JS package by trying local module resolution first, then CDN URL.
 * Supports dependency injection via `customLoader` for offline testing.
 */
async function loadModule(pkgName, cdnUrl, customLoader = null) {
    if (typeof customLoader === 'function') {
        const res = await customLoader(pkgName, cdnUrl);
        if (res) return res;
    }

    try {
        const mod = await import(/* @vite-ignore */ pkgName);
        if (mod) return mod;
    } catch {
        // Fallback to CDN
    }

    if (cdnUrl) {
        try {
            return await import(/* @vite-ignore */ cdnUrl);
        } catch (err) {
            if (!/^https?:\/\/esm\.sh\//i.test(cdnUrl)) {
                try {
                    const fallbackUrl = `https://esm.sh/${pkgName}`;
                    return await import(/* @vite-ignore */ fallbackUrl);
                } catch { /* fall through */ }
            }
            throw new Error(`Failed to load WASM package '${pkgName}' from ${cdnUrl}: ${err.message || err}`);
        }
    }

    throw new Error(`Package '${pkgName}' could not be loaded`);
}

/**
 * Parses `Usage:` and CLI option lines (`-f`, `--flag`) from runtime `--help` output
 * or extracted WebAssembly data-section text.
 */
function extractHelpFromText(text, scanBareFlags = false) {
    const res = { usage: null, options: [] };
    if (!text || typeof text !== 'string') return res;

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const seenOpts = new Set();

    // If a "Usage:" line exists when scanning raw binary strings, prefer scanning options from that point onward
    const usageIdx = scanBareFlags ? lines.findIndex(l => /^usage:\s*(.+)/i.test(l)) : -1;
    const startIdx = usageIdx >= 0 ? usageIdx : 0;

    for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (!res.usage && /^usage:\s*(.+)/i.test(line)) {
            res.usage = line.replace(/^usage:\s*/i, '').trim();
        } else if (
            /^(?:-[a-zA-Z0-9?]|--[a-zA-Z0-9][-a-zA-Z0-9]*)(?:\s|,|=|<|\[|$)/.test(line) &&
            line.length <= 120 &&
            !/^(?:-[hHvV],\s*)?--(?:help|version)\b/i.test(line) &&
            (!scanBareFlags || /^(?:-[a-zA-Z?]|--[a-zA-Z][a-zA-Z0-9-]*)(?:,\s*--?[a-zA-Z0-9-]+)?(?:\s+[<\[a-zA-Z0-9_.->\]]+)*(?:\s+[A-Za-z`'"(][A-Za-z0-9 ,.;:()'"`/<>\[\]=+$\t_-]*|)$/.test(line))
        ) {
            if (!seenOpts.has(line)) {
                seenOpts.add(line);
                res.options.push(line);
            }
        }
    }

    if (scanBareFlags && res.options.length === 0) {
        const flagMatches = text.match(/--[a-z][a-z0-9-]{1,24}/g) || [];
        for (const fl of Array.from(new Set(flagMatches)).slice(0, 12)) {
            if (fl !== '--help' && fl !== '--version') {
                res.options.push(fl);
            }
        }
    }

    return res;
}

/**
 * Introspects a compiled WebAssembly binary (`Uint8Array`) at runtime to extract:
 * - Embedded `Usage:` strings and CLI option flags (`--flag`, `-f`) from the `.wasm` data section
 * - Exported WASM functions (`_start`, `main`, custom exports)
 * - Imported WASI capabilities (`args_get`, `path_open`, `fd_read`, `fd_write`, etc.)
 */
function inspectWasmBytes(bytes) {
    const info = {
        usage: null,
        options: [],
        exports: [],
        wasiImports: [],
        hasAsyncify: false,
        isInteractive: false
    };
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) return info;

    try {
        if (typeof WebAssembly !== 'undefined' && WebAssembly.Module) {
            const mod = new WebAssembly.Module(bytes);
            info.exports = WebAssembly.Module.exports(mod)
                .filter(e => e.kind === 'function')
                .map(e => e.name);
            info.wasiImports = WebAssembly.Module.imports(mod)
                .filter(i => i.module.startsWith('wasi_'))
                .map(i => i.name);

            info.hasAsyncify = info.exports.includes('asyncify_start_unwind') && info.exports.includes('asyncify_stop_unwind');
            if (info.exports.includes('set_terminal_size')) {
                info.isInteractive = true;
            }
        }
    } catch {
        // Ignore if bytes are WAT or non-standard
    }

    try {
        const chunks = [];
        let cur = '';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            if ((b >= 32 && b <= 126) || b === 9 || b === 10) {
                cur += String.fromCharCode(b);
            } else {
                if (cur.length >= 4) chunks.push(cur);
                cur = '';
            }
        }
        if (cur.length >= 4) chunks.push(cur);

        const allText = chunks.join('\n');
        if (!info.isInteractive) {
            if (allText.includes('/dev/tty') || allText.includes('\x1b[?1049h') || allText.includes('smcup') || allText.includes('xterm')) {
                info.isInteractive = true;
            }
        }

        const parsed = extractHelpFromText(allText, true);
        info.usage = parsed.usage;
        info.options = parsed.options;
    } catch {
        // Ignore string scan errors
    }

    return info;
}

/**
 * Formats a fallback `--help` screen for a WASM binary when the binary itself
 * does not print its own `--help` output to stdout/stderr. Uses runtime WASM
 * binary introspection (`inspectWasmBytes`) when available.
 */
function formatWasmHelp(binName, pkgMeta = {}, inspected = null) {
    const pkgName = pkgMeta.name || binName;
    const version = pkgMeta.version || 'wasm';
    const desc = pkgMeta.description || 'WebAssembly binary';
    const replCfg = (pkgMeta && typeof pkgMeta.repl === 'object') ? pkgMeta.repl : (pkgMeta.repl ? {} : null);

    const rawDetectedUsage = (inspected && inspected.usage) || pkgMeta.usage;
    const detectedUsage = rawDetectedUsage ? rawDetectedUsage.replace(/%s/g, binName) : null;
    const defaultUsage = replCfg
        ? `${binName} [options] ${replCfg.evalFlag ? `[${replCfg.evalFlag} <code>] ` : ''}[file] [args...]`
        : `${binName} [options] [args...]`;

    const lines = [
        `${binName} (${pkgName} ${version} wasm) — ${desc}`,
        `Usage: ${detectedUsage || defaultUsage}`
    ];

    if (pkgMeta.details) {
        lines.push('', pkgMeta.details);
    }

    lines.push('', 'Options:');
    const detectedOptions = (inspected && inspected.options && inspected.options.length > 0)
        ? inspected.options
        : (Array.isArray(pkgMeta.options) ? pkgMeta.options : []);

    if (detectedOptions.length > 0) {
        for (const opt of detectedOptions) {
            lines.push(`  ${opt}`);
        }
    } else if (replCfg) {
        if (replCfg.evalFlag) {
            lines.push(`  ${replCfg.evalFlag.padEnd(20)}Evaluate inline code and print result`);
        }
        lines.push(`  (no arguments)      Start interactive ${binName} REPL shell`);
    }
    lines.push('  -h, --help          Show this help message and exit');
    lines.push('  -V, --version       Show WebAssembly binary version and exit');

    if (inspected && inspected.exports && inspected.exports.length > 0) {
        lines.push('', `WASM Exports: ${inspected.exports.join(', ')}`);
    }
    if (Array.isArray(pkgMeta.aliases) && pkgMeta.aliases.length > 0) {
        lines.push('', `Aliases: ${pkgMeta.aliases.join(', ')}`);
    }
    if (pkgMeta.homepage || pkgMeta.cdnUrl || pkgMeta.wasmUrl) {
        lines.push(`Source:  ${pkgMeta.homepage || pkgMeta.cdnUrl || pkgMeta.wasmUrl}`);
    }

    return lines;
}

/**
 * Pure generic non-interactive WASM & CLI Command builder for brsh.
 *
 * Supports three standard, runtime-agnostic execution conventions:
 * 1. Raw WebAssembly binary (`.wasm` / `.wat` via `wasmUrl`, `Uint8Array`, `ArrayBuffer`, or `{ wasmBytes }`) ->
 *    Executed via `WasmCommand` with full WASI (`wasi_snapshot_preview1`) filesystem, argv, env, and stdio.
 * 2. Emscripten modularized factory (`export default async function Module(opts)`) ->
 *    Syncs input/output files between the `brsh` filesystem and Emscripten `FS` (or `writeFile`/`readFile`),
 *    wires `stdin`/`print`/`printErr`, and invokes `callMain(args)` or `exec(args)`.
 * 3. Standard CLI module interface (`main(args, io)`, `run(args, io)`, `callMain(args)`, `exec(args)`) ->
 *    Passes `args` and a standard `{ binName, args, stdin, fs, context, stdout, stderr, readFile, writeFile }`
 *    I/O bridge to the module's entry function.
 *
 * Interactive REPL support is provided separately by `ReplCommand` (`lib/ReplCommand.js`),
 * which extends `createGenericWasmCommand`.
 */
function createGenericWasmCommand(pkgMeta, config = {}, binNameOverride = null) {
    const Command = require('./Command');
    const binName = (binNameOverride || pkgMeta.bin || pkgMeta.name).toLowerCase();

    class GenericWasmCommand extends Command {
        static get name() { return binName; }
        get name() { return binName; }
        get requiresFilesystem() { return true; }

        get interactive() {
            if (this._subCommand) return this._subCommand.interactive;
            if (this._isInteractive !== undefined) return Boolean(this._isInteractive);
            if (pkgMeta && (pkgMeta.interactive || pkgMeta.wasm?.interactive)) return true;
            if (this._inspectedWasm && this._inspectedWasm.isInteractive) return true;
            return false;
        }

        get captureInput() {
            if (this._subCommand) return Boolean(this._subCommand.captureInput);
            return this.interactive;
        }

        get isRaw() {
            if (this._subCommand) {
                return Boolean(this._subCommand.isRaw || (this._subCommand.stdinStream && this._subCommand.stdinStream.isRaw));
            }
            return Boolean(this.stdinStream && this.stdinStream.isRaw);
        }

        get _inAltScreen() {
            return Boolean(this.__inAltScreen || (this._subCommand && this._subCommand._inAltScreen));
        }

        set _inAltScreen(val) {
            this.__inAltScreen = Boolean(val);
        }

        kill(signal = 'SIGINT') {
            if (this._subCommand && typeof this._subCommand.kill === 'function') {
                this._subCommand.kill(signal);
            }
            super.kill(signal);
        }

        onInput(char) {
            if (this._subCommand && typeof this._subCommand.onInput === 'function') {
                this._subCommand.onInput(char);
            }
        }

        async run() {
            const args = [...(this.arguments || [])];
            const isHelp = args.includes('--help') || args.includes('-h');
            const isVersion = !isHelp && (args.includes('--version') || args.includes('-V') || args.includes('-v'));
            const fs = this.fs || (this.context && this.context.fs);
            this._inspectedWasm = null;
            this._persistedWasmBytes = pkgMeta.wasmPath
                ? readBytesFromFs(fs, pkgMeta.wasmPath)
                : null;
            if (isHelp && this._persistedWasmBytes && this._persistedWasmBytes.byteLength > 0) {
                this._inspectedWasm = inspectWasmBytes(this._persistedWasmBytes);
            }

            try {
                // 1. Direct `.wasm` URL or persisted raw WASI binary -> run via WasmCommand
                if ((pkgMeta.type === 'wasm' || pkgMeta.type === 'custom-wasm') && (this._persistedWasmBytes || pkgMeta.wasmUrl)) {
                    let bytes = this._persistedWasmBytes;
                    if (!bytes && config.moduleLoader) {
                        try {
                            const loaded = await config.moduleLoader(pkgMeta.name, pkgMeta.cdnUrl);
                            if (loaded instanceof Uint8Array || loaded instanceof ArrayBuffer) {
                                bytes = loaded instanceof Uint8Array ? loaded : new Uint8Array(loaded);
                            } else if (loaded && (loaded.wasmBytes || loaded.wasm || loaded.wasmBinary)) {
                                bytes = loaded.wasmBytes || loaded.wasm || loaded.wasmBinary;
                            }
                        } catch { /* ignore */ }
                    }
                    if (!bytes && pkgMeta.wasmUrl) {
                        bytes = await this._fetchWasmBytes(pkgMeta.wasmUrl);
                    }
                    if (bytes) {
                        if (isHelp) this._inspectedWasm = inspectWasmBytes(bytes);
                        await this._runRawWasmBytes(bytes, args);
                        return;
                    }
                } else {
                    const cdnUrl = pkgMeta.cdnUrl || pkgMeta.wasmUrl || `https://esm.sh/${pkgMeta.name}`;
                    const origFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
                    if (origFetch && this._persistedWasmBytes && this._persistedWasmBytes.byteLength > 0 && typeof Response !== 'undefined') {
                        const wasmBytes = this._persistedWasmBytes;
                        const wasmUrl = pkgMeta.wasmUrl || '';
                        globalThis.fetch = async (input, init) => {
                            const reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                            if (reqUrl && (reqUrl === wasmUrl || (!/^https?:\/\//i.test(reqUrl) && /\.wasm(\?.*)?$/i.test(reqUrl)))) {
                                return new Response(wasmBytes, {
                                    status: 200,
                                    headers: { 'Content-Type': 'application/wasm' }
                                });
                            }
                            return origFetch(input, init);
                        };
                    }
                    let loaded;
                    let target;
                    try {
                        loaded = await loadModule(pkgMeta.name, cdnUrl, config.moduleLoader);
                        target = (loaded && loaded.default !== undefined) ? loaded.default : loaded;
                        if (target && typeof target.then === 'function') {
                            target = await target;
                        }
                    } finally {
                        if (origFetch) globalThis.fetch = origFetch;
                    }

                    // 2. Raw WASM binary (Uint8Array or ArrayBuffer)
                    if (target instanceof Uint8Array || target instanceof ArrayBuffer) {
                        const bytes = target instanceof Uint8Array ? target : new Uint8Array(target);
                        if (isHelp) this._inspectedWasm = inspectWasmBytes(bytes);
                        await this._runRawWasmBytes(bytes, args);
                    } else if (target && (target.wasmBytes instanceof Uint8Array || target.wasm instanceof Uint8Array)) {
                        const bytes = target.wasmBytes || target.wasm;
                        if (isHelp) this._inspectedWasm = inspectWasmBytes(bytes);
                        await this._runRawWasmBytes(bytes, args);
                    } else if (typeof target === 'function') {
                        // 3. Factory / constructor / CLI function (`export default function(opts)` or class)
                        await this._runFunctionOrEmscripten(target, args, isHelp, isVersion);
                    } else if (target && typeof target === 'object') {
                        // 4. Standard CLI module object (`main`, `run`, `callMain`, `exec`)
                        if (target.ready) await target.ready;
                        if (isHelp && (target.HEAPU8 instanceof Uint8Array || target.wasmBinary instanceof Uint8Array)) {
                            this._inspectedWasm = inspectWasmBytes(target.wasmBinary || target.HEAPU8);
                        }
                        const entryFn = target.main || target.run || target.callMain || target.exec;
                        if (typeof entryFn === 'function') {
                            await this._invokeCliFunction(entryFn.bind(target), args);
                        } else if (target.promised || typeof target.raw === 'function' || typeof target.json === 'function') {
                            const jqInst = target.promised ? await target.promised : target;
                            const flags = args.filter(a => a.startsWith('-'));
                            const pos = args.filter(a => !a.startsWith('-'));
                            const filter = pos.shift() || '.';
                            const io = this._createIoBridge(args, [], []);
                            const input = pos.length > 0 ? (io.readFile(pos[0]) || '') : (io.stdin || (isHelp || isVersion ? '{}' : ''));
                            const out = typeof jqInst.raw === 'function'
                                ? jqInst.raw(input, filter, flags)
                                : (!isHelp && !isVersion ? JSON.stringify(jqInst.json(JSON.parse(input || 'null'), filter)) : null);
                            if (out != null) {
                                String(out).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                            }
                        } else if (!isHelp && !isVersion) {
                            this.stdErr = `${binName}: unsupported WASM module format for '${pkgMeta.name}'`;
                            this.exitCode = 1;
                            return;
                        }
                    } else if (!isHelp && !isVersion) {
                        this.stdErr = `${binName}: unsupported WASM module format for '${pkgMeta.name}'`;
                        this.exitCode = 1;
                        return;
                    }
                }
            } catch (err) {
                if (!isHelp && !isVersion) {
                    if (err && typeof err.status === 'number') {
                        this.exitCode = err.status;
                        return;
                    }
                    this.stdErr = `${binName}: ${err.message || err}`;
                    this.exitCode = 1;
                    return;
                }
            }

            // If `--help` or `--version` was requested:
            // - If the WASM binary emitted its own native help output, pass it through directly!
            // - Otherwise, fall back to runtime binary inspection (`this._inspectedWasm`) + `formatWasmHelp`.
            if (isHelp || isVersion) {
                const stdLines = (this.result && this.result.getStdOutput) ? this.result.getStdOutput() : [];
                const allText = stdLines.map(l => l.string).join('\n');
                const parsedHelp = isHelp ? extractHelpFromText(allText) : null;
                const hasNativeHelp = isHelp && Boolean(
                    (parsedHelp && (parsedHelp.usage || parsedHelp.options.length > 0)) ||
                    stdLines.some(l => /\b(usage|options):/i.test(l.string))
                );
                const outOnly = stdLines.filter(l => l.type === 'out').map(l => l.string);
                const hasNativeVersion = isVersion && outOnly.length > 0 && (this.exitCode === 0 || this.exitCode === undefined);

                if (isHelp) {
                    if (hasNativeHelp) {
                        // Promote any stderr help lines to stdout and return exitCode 0
                        const nativeLines = stdLines.map(l => l.string);
                        if (this.result && Array.isArray(this.result.std)) {
                            this.result.std.length = 0;
                        }
                        this.exitCode = 0;
                        for (const line of nativeLines) {
                            this.stdOut = line;
                        }
                    } else {
                        if (this.result && Array.isArray(this.result.std)) {
                            this.result.std.length = 0;
                        }
                        this.exitCode = 0;
                        for (const line of formatWasmHelp(binName, pkgMeta, this._inspectedWasm)) {
                            this.stdOut = line;
                        }
                    }
                } else if (isVersion && !hasNativeVersion) {
                    if (this.result && Array.isArray(this.result.std)) {
                        this.result.std.length = 0;
                    }
                    this.exitCode = 0;
                    this.stdOut = `${binName} (${pkgMeta.name} ${pkgMeta.version || 'wasm'} wasm)`;
                } else {
                    this.exitCode = 0;
                }
            }
        }

        async _fetchWasmBytes(url) {
            if (wasmByteCache.has(url)) return wasmByteCache.get(url);
            const fetchFn = config.fetch || (typeof fetch === 'function' ? fetch : null);
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
            wasmCmd._pkgMeta = pkgMeta;
            wasmCmd.stdinStream = this.stdinStream;
            wasmCmd.stdout = this.stdout;
            wasmCmd.stderr = this.stderr;
            wasmCmd.stdin = (this.stdin && !this.stdin.isTTY) ? this.stdin : this.stdinStream;
            if (this._onStdinStreamData && this.stdinStream && typeof this.stdinStream.off === 'function') {
                this.stdinStream.off('data', this._onStdinStreamData);
            }
            const onSubInteractive = () => {
                this.emit('interactive');
                if (this.context && typeof this.context.emit === 'function') {
                    this.context.emit('interactive');
                }
            };
            wasmCmd.on('interactive', onSubInteractive);
            this._subCommand = wasmCmd;
            try {
                await wasmCmd._runWasm(bytes);
            } finally {
                wasmCmd.removeListener('interactive', onSubInteractive);
                if (wasmCmd._inAltScreen) {
                    wasmCmd._exitAltScreen();
                }
                this._subCommand = null;
                if (this._onStdinStreamData && this.stdinStream && typeof this.stdinStream.on === 'function') {
                    this.stdinStream.on('data', this._onStdinStreamData);
                }
            }
            for (const line of wasmCmd.result.getStdOutput()) {
                if (line.type === 'out') this.stdOut = line.string;
                else if (line.type === 'err') this.stdErr = line.string;
            }
            this.exitCode = wasmCmd.result.getExitCode();
        }

        _createIoBridge(args, outLines, errLines) {
            const createStream = (lines) => ({
                write(chunk) {
                    const str = chunk instanceof Uint8Array
                        ? new TextDecoder().decode(chunk)
                        : String(chunk ?? '');
                    str.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => lines.push(l));
                }
            });

            return {
                binName,
                args,
                stdin: this.stdin !== undefined && this.stdin !== null ? String(this.stdin) : '',
                fs: this.fs,
                context: this.context,
                wasmPath: pkgMeta.wasmPath || null,
                wasmBytes: this._persistedWasmBytes || null,
                stdout: Object.assign((line) => outLines.push(String(line)), createStream(outLines)),
                stderr: Object.assign((line) => errLines.push(String(line)), createStream(errLines)),
                readFile: (filename, baseDir) => {
                    if (!this.fs) return null;
                    const relPath = baseDir && baseDir !== '.' && !filename.startsWith('/')
                        ? `${baseDir.replace(/\/+$/, '')}/${filename}`
                        : filename;
                    const content = this.fs.getFileByPath(relPath) ?? this.fs.getFileByPath(filename);
                    if (content === null || content === undefined) return null;
                    return typeof content === 'string' ? content : new TextDecoder().decode(content);
                },
                readBytes: (filename) => readBytesFromFs(this.fs, filename),
                writeFile: (filename, contents, baseDir) => {
                    if (!this.fs) return;
                    const targetPath = baseDir && baseDir !== '.' && !filename.startsWith('/')
                        ? `${baseDir.replace(/\/+$/, '')}/${filename}`
                        : filename;
                    if (contents instanceof Uint8Array || ArrayBuffer.isView(contents)) {
                        const mime = targetPath.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
                        writeBytesToFs(this.fs, targetPath, contents, mime);
                    } else {
                        this.fs.setFileByPath(targetPath, String(contents), true);
                    }
                    if (targetPath.endsWith('.wasm') || targetPath.endsWith('.wat')) {
                        try {
                            this.fs.setMode(targetPath, 0o755);
                        } catch { /* ignore */ }
                    }
                },
                listFiles: (dirname, baseDir) => {
                    if (!this.fs) return [];
                    const targetDir = baseDir && baseDir !== '.' && !dirname.startsWith('/')
                        ? `${baseDir.replace(/\/+$/, '')}/${dirname}`
                        : dirname;
                    const dirObj = this.fs.getFileByPath(targetDir);
                    if (dirObj && typeof dirObj === 'object' && !(dirObj instanceof Uint8Array)) {
                        return Object.keys(dirObj);
                    }
                    return [];
                }
            };
        }

        async _runFunctionOrEmscripten(fn, args, isHelp = false, isVersion = false) {
            const outLines = [];
            const errLines = [];
            const stdinBytes = new TextEncoder().encode(this.stdin || '');
            let stdinPos = 0;

            let preSyncedFiles = new Set();
            const emscriptenConfig = {
                arguments: args,
                noInitialRun: true,
                ...(this._persistedWasmBytes && this._persistedWasmBytes.byteLength > 0
                    ? { wasmBinary: this._persistedWasmBytes }
                    : {}),
                ...(pkgMeta.wasmUrl
                    ? { locateFile: (file) => (file.endsWith('.wasm') ? pkgMeta.wasmUrl : file) }
                    : {}),
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

            const ioBridge = this._createIoBridge(args, outLines, errLines);

            let result;
            try {
                if (fn.prototype && fn.prototype.constructor === fn && Object.getOwnPropertyNames(fn.prototype).length > 1) {
                    result = new fn(emscriptenConfig, ioBridge);
                } else {
                    result = await fn(emscriptenConfig, ioBridge);
                }
            } catch (err) {
                if (err && typeof err.status === 'number') {
                    this.exitCode = err.status;
                } else {
                    throw err;
                }
            }

            if (result && typeof result === 'object') {
                if (isHelp && (result.wasmBinary instanceof Uint8Array || result.HEAPU8 instanceof Uint8Array)) {
                    this._inspectedWasm = inspectWasmBytes(result.wasmBinary || result.HEAPU8);
                }
                if (typeof result.callMain === 'function') {
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
                } else if (typeof result.exec === 'function' && typeof result.writeFile === 'function') {
                    await this._runVirtualFsInstance(result, args, outLines, errLines);
                } else if (typeof result.main === 'function' || typeof result.run === 'function') {
                    const entry = (result.main || result.run).bind(result);
                    await this._invokeCliFunction(entry, args, outLines, errLines);
                } else if (!isHelp && !isVersion && typeof result.Database === 'function') {
                    this._runSqlJsDatabase(result, args, ioBridge, outLines);
                } else {
                    if (typeof result.stdout === 'string' && result.stdout) {
                        result.stdout.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
                    }
                    if (typeof result.stderr === 'string' && result.stderr) {
                        result.stderr.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => errLines.push(l));
                    }
                    if (result.error && errLines.length === 0) {
                        errLines.push(result.error.message || String(result.error));
                        this.exitCode = 1;
                    }
                    if (typeof result.exitCode === 'number') {
                        this.exitCode = result.exitCode;
                    }
                }
            } else if (typeof result === 'string') {
                result.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
            } else if (typeof result === 'number') {
                this.exitCode = result;
            }

            outLines.forEach(l => { this.stdOut = l; });
            errLines.forEach(l => { this.stdErr = l; });
        }

        _runSqlJsDatabase(SQL, args, io, outLines) {
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
                if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA|WITH|BEGIN|EXPLAIN|\.)\b/i.test(positional[0])) {
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
            if (!sql) return;

            const existingBytes = dbPath !== ':memory:' ? io.readBytes(dbPath) : null;
            const db = existingBytes && existingBytes.byteLength > 0
                ? new SQL.Database(existingBytes)
                : new SQL.Database();

            try {
                if (sql.trim() === '.tables') {
                    const res = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
                    const names = (res[0] && res[0].values) ? res[0].values.map(r => r[0]) : [];
                    if (names.length > 0) outLines.push(names.join('  '));
                } else {
                    const results = db.exec(sql);
                    for (const r of results) {
                        const cols = (r.columns || []).map(String);
                        const rows = r.values || [];
                        if (mode === 'table' && cols.length > 0) {
                            const widths = cols.map(c => c.length);
                            const norm = rows.map(row => cols.map((_, i) => {
                                const s = row[i] == null ? 'NULL' : String(row[i]);
                                if (s.length > widths[i]) widths[i] = s.length;
                                return s;
                            }));
                            outLines.push(cols.map((c, i) => ' ' + c.padEnd(widths[i]) + ' ').join('|'));
                            outLines.push(widths.map(w => '-'.repeat(w + 2)).join('+'));
                            norm.forEach(row => outLines.push(row.map((c, i) => ' ' + c.padEnd(widths[i]) + ' ').join('|')));
                        } else if (mode === 'csv') {
                            const esc = (v) => {
                                const s = v == null ? '' : String(v);
                                return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
                            };
                            if (cols.length > 0) outLines.push(cols.map(esc).join(','));
                            rows.forEach(row => outLines.push(cols.map((_, i) => esc(row[i])).join(',')));
                        } else {
                            rows.forEach(row => outLines.push(cols.map((_, i) => (row[i] == null ? '' : String(row[i]))).join('|')));
                        }
                    }
                }
                if (dbPath !== ':memory:') {
                    io.writeFile(dbPath, db.export());
                }
            } finally {
                db.close();
            }
        }

        async _runVirtualFsInstance(instance, args, outLines, errLines) {
            if (typeof instance.on === 'function') {
                instance.on('log', ({ message }) => {
                    if (message) outLines.push(message);
                });
            }
            if (!instance.loaded && typeof instance.load === 'function') {
                await instance.load(pkgMeta.coreUrl ? { coreURL: pkgMeta.coreUrl } : undefined);
            }

            const existingInputs = new Set();
            const candidatePaths = [];
            for (const arg of args) {
                if (arg.startsWith('-')) continue;
                candidatePaths.push(arg);
                if (this.fs.exists(arg)) {
                    const bytes = readBytesFromFs(this.fs, arg);
                    if (bytes) {
                        await instance.writeFile(arg, bytes);
                        existingInputs.add(arg);
                    }
                }
            }

            const code = await instance.exec(args);
            for (const candidate of candidatePaths) {
                if (existingInputs.has(candidate)) continue;
                try {
                    if (typeof instance.readFile === 'function') {
                        const outData = await instance.readFile(candidate);
                        if (outData) writeBytesToFs(this.fs, candidate, outData);
                    }
                } catch { /* ignore */ }
            }

            if (typeof code === 'number' && code !== 0) {
                this.exitCode = code;
                if (errLines.length === 0 && outLines.length > 0) {
                    errLines.push(...outLines.splice(0, outLines.length));
                }
            }
        }

        async _invokeCliFunction(fn, args, existingOut = null, existingErr = null) {
            const outLines = existingOut || [];
            const errLines = existingErr || [];
            const ioBridge = this._createIoBridge(args, outLines, errLines);

            const res = await fn(args, ioBridge);
            if (typeof res === 'string') {
                res.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
            } else if (typeof res === 'number') {
                this.exitCode = res;
            } else if (res && typeof res === 'object') {
                if (typeof res.stdout === 'string' && res.stdout) {
                    res.stdout.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => outLines.push(l));
                }
                if (typeof res.stderr === 'string' && res.stderr) {
                    res.stderr.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => errLines.push(l));
                }
                if (res.error) {
                    if (errLines.length === 0) errLines.push(res.error.message || String(res.error));
                    this.exitCode = typeof res.exitCode === 'number' ? res.exitCode : 1;
                } else if (typeof res.exitCode === 'number') {
                    this.exitCode = res.exitCode;
                }
            }

            if (!existingOut) {
                outLines.forEach(l => { this.stdOut = l; });
                errLines.forEach(l => { this.stdErr = l; });
            }
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
                        const mime = arg.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
                        writeBytesToFs(this.fs, arg, data, mime);
                        if (arg.endsWith('.wasm') || arg.endsWith('.wat')) {
                            try {
                                this.fs.setMode(arg, 0o755);
                            } catch { /* ignore */ }
                        }
                    }
                } catch {
                    // Not an output file in Emscripten FS
                }
            }
        }
    }

    return GenericWasmCommand;
}

function isWasmFile(filepath, content) {
    if (filepath && (filepath.endsWith('.wasm') || filepath.endsWith('.wat'))) return true;
    if (content instanceof Uint8Array) {
        return content.length >= 4 && content[0] === 0x00 && content[1] === 0x61 && content[2] === 0x73 && content[3] === 0x6d;
    }
    if (typeof content !== 'string') return false;
    // Binary WASM: magic bytes \0asm
    if (content.charCodeAt(0) === 0 && content.slice(1, 4) === 'asm') return true;
    // WAT text format
    return content.trimStart().startsWith('(module');
}

function readSiblingPkgMeta(fs, filepath) {
    if (!fs || !filepath || typeof fs.exists !== 'function' || typeof fs.getFileByPath !== 'function') {
        return null;
    }
    try {
        const dirParts = filepath.split('/').filter(Boolean);
        dirParts.pop();
        const pkgJsonPath = (dirParts.length ? '/' + dirParts.join('/') : '') + '/package.json';
        if (fs.exists(pkgJsonPath)) {
            const rawJson = fs.getFileByPath(pkgJsonPath);
            if (typeof rawJson === 'string') {
                return JSON.parse(rawJson);
            }
        }
    } catch (_) {}
    return null;
}

WasmCommand.isWasmFile = isWasmFile;
WasmCommand.readSiblingPkgMeta = readSiblingPkgMeta;
WasmCommand.readBytesFromFs = readBytesFromFs;
WasmCommand.writeBytesToFs = writeBytesToFs;
WasmCommand.loadModule = loadModule;
WasmCommand.extractHelpFromText = extractHelpFromText;
WasmCommand.inspectWasmBytes = inspectWasmBytes;
WasmCommand.formatWasmHelp = formatWasmHelp;
WasmCommand.createGenericWasmCommand = createGenericWasmCommand;
WasmCommand.createCommand = createGenericWasmCommand;

module.exports = WasmCommand;

'use strict';

const ScriptCommand = require('./ScriptCommand');
const { BinaryFile } = require('./FileSystem');

// WASI errno constants
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_EXIST = 20;
const ERRNO_INVAL = 28;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOTDIR = 54;
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

class WasmCommand extends ScriptCommand {
    // this.script = filepath (set by ScriptCommand parent constructor)

    get name() { return 'wasm'; }
    get requiresFilesystem() { return true; }

    run() {
        const filepath = this.script;
        const nodeFs = (() => { try { return require('fs'); } catch { return null; } })();

        return this._loadBytes(filepath, nodeFs)
            .then(({ bytes, isWat }) => isWat ? this._runWat(bytes) : this._runWasm(bytes))
            .catch(e => {
                this.stdErr = e.message || String(e);
                this.exitCode = 1;
            });
    }

    _loadBytes(filepath, nodeFs) {
        if (this.context.fs.isRealFilesystem && nodeFs) {
            try {
                const buf = nodeFs.readFileSync(this.context.fs.absolutePath(filepath));
                const bytes = new Uint8Array(buf);
                return Promise.resolve({ bytes, isWat: this._isWat(filepath, bytes) });
            } catch(e) {
                return Promise.reject(new Error(`${filepath}: ${e.message}`));
            }
        }
        const content = this.context.fs.getFileByPath(filepath);
        if (content == null) return Promise.reject(new Error(`${filepath}: No such file or directory`));
        const bytes = this._contentToBytes(content);
        return Promise.resolve({ bytes, isWat: this._isWat(filepath, bytes) });
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

        const writeFd = (fd, text) => {
            outBuf[fd] = (outBuf[fd] || '') + text;
            const lines = outBuf[fd].split('\n');
            outBuf[fd] = lines.pop();
            for (const line of lines) {
                if (fd === 1) this.stdOut = line;
                else this.stdErr = line;
            }
        };

        const flushFd = () => {
            if (outBuf[1]) { this.stdOut = outBuf[1]; outBuf[1] = ''; }
            if (outBuf[2]) { this.stdErr = outBuf[2]; outBuf[2] = ''; }
        };

        const stdinBytes = encoder.encode(this.stdin || '');
        let stdinPos = 0;

        // ── Virtual WASI file descriptor table backed by this.context.fs ──
        // fd 0: stdin, fd 1: stdout, fd 2: stderr
        // fd 3: pre-opened root directory '/'
        // fd 4: pre-opened current working directory '.'
        const fs = this.context && this.context.fs ? this.context.fs : this.fs;
        let nextFd = 5;
        const fdTable = new Map([
            [3, { type: 'preopen', path: '/', guestName: '/' }],
            [4, { type: 'preopen', path: (fs && fs.cwd) || '/', guestName: '.' }]
        ]);

        const resolveGuestPath = (dirFd, relPath) => {
            const dirEntry = fdTable.get(dirFd);
            if (!dirEntry || (dirEntry.type !== 'preopen' && dirEntry.type !== 'dir')) return null;
            if (relPath.startsWith('/')) return fs.absolutePath(relPath);
            const base = dirEntry.path.endsWith('/') ? dirEntry.path : dirEntry.path + '/';
            return fs.absolutePath(base + relPath);
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

        // Environment variables from context.vars
        const envPairs = Object.entries((this.context && this.context.vars) || {})
            .map(([k, v]) => `${k}=${v}`);

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
                if (!entry || entry.type !== 'file') return ERRNO_BADF;

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

                if (fd === 0) {
                    let total = 0;
                    for (let i = 0; i < iovs_len && stdinPos < stdinBytes.length; i++) {
                        const ptr = view.getUint32(iovs + i * 8, true);
                        const len = view.getUint32(iovs + i * 8 + 4, true);
                        const chunk = Math.min(len, stdinBytes.length - stdinPos);
                        new Uint8Array(memRef.buffer).set(stdinBytes.slice(stdinPos, stdinPos + chunk), ptr);
                        stdinPos += chunk;
                        total += chunk;
                    }
                    view.setUint32(nread_ptr, total, true);
                    return ERRNO_SUCCESS;
                }

                const entry = fdTable.get(fd);
                if (!entry || entry.type !== 'file') return ERRNO_BADF;

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
                if (!entry || entry.type !== 'file') return ERRNO_BADF;

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
                flushOpenFile(entry);
                fdTable.delete(fd);
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
                    filetype = (entry.type === 'preopen' || entry.type === 'dir')
                        ? FILETYPE_DIRECTORY
                        : FILETYPE_REGULAR_FILE;
                }
                // struct fdstat (24 bytes): fs_filetype (u8), fs_flags (u16), rights_base (u64), rights_inheriting (u64)
                for (let i = 0; i < 24; i++) view.setUint8(stat_ptr + i, 0);
                view.setUint8(stat_ptr, filetype);
                view.setBigUint64(stat_ptr + 8, 0xffffffffffffffffn, true);
                view.setBigUint64(stat_ptr + 16, 0xffffffffffffffffn, true);
                return ERRNO_SUCCESS;
            },
            fd_fdstat_set_flags: () => ERRNO_SUCCESS,
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
                const st = fs.stat(absPath);
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
                    const ns = BigInt(Date.now()) * 1_000_000n;
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

            const instance = await WebAssembly.instantiate(module, imports);

            // Prefer the module's own exported memory
            if (instance.exports.memory) memRef = instance.exports.memory;

            const start = instance.exports._start
                || instance.exports.__wasi_command
                || instance.exports.main
                || instance.exports.run;

            if (!start) {
                this.stdErr = `${this.script}: no entry point found (export _start, main, or run)`;
                this.exitCode = 1;
            } else {
                try {
                    await start();
                } catch(e) {
                    if (!e || !e._wasmExit) {
                        this.stdErr = `${this.script}: runtime error: ${e?.message || String(e)}`;
                        this.exitCode = 1;
                    }
                }
            }
        } catch(e) {
            if (!e || !e._wasmExit) {
                this.stdErr = `${this.script}: ${e?.message || String(e)}`;
                this.exitCode = 1;
            }
        } finally {
            // Flush any open dirty WASI file descriptors back to the brsh filesystem
            for (const entry of fdTable.values()) {
                flushOpenFile(entry);
            }
        }

        flushFd();
    }
}

module.exports = WasmCommand;

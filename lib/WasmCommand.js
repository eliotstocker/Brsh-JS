'use strict';

const ScriptCommand = require('./ScriptCommand');

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
        try {
            const wabtInit = require('wabt');
            const wabt = typeof wabtInit === 'function' ? await wabtInit() : wabtInit;
            const parsed = wabt.parseWat(this.script, text, { mutable_globals: true });
            const { buffer } = parsed.toBinary({});
            wasmBytes = new Uint8Array(buffer);
        } catch(e) {
            if (e.code === 'MODULE_NOT_FOUND') {
                this.stdErr = `${this.script}: WAT execution requires the 'wabt' package`;
                this.stdErr = `Install it with: npm install wabt`;
            } else {
                this.stdErr = `${this.script}: WAT compilation error: ${e.message}`;
            }
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

        const stdinBytes = new TextEncoder().encode(this.stdin || '');
        let stdinPos = 0;

        const wasi = {
            fd_write: (fd, iovs, iovs_len, nwritten_ptr) => {
                if (!memRef) return 8;
                const view = new DataView(memRef.buffer);
                let total = 0;
                for (let i = 0; i < iovs_len; i++) {
                    const ptr = view.getUint32(iovs + i * 8, true);
                    const len = view.getUint32(iovs + i * 8 + 4, true);
                    if (len > 0) writeFd(fd, decoder.decode(new Uint8Array(memRef.buffer, ptr, len)));
                    total += len;
                }
                view.setUint32(nwritten_ptr, total, true);
                return 0;
            },
            fd_read: (fd, iovs, iovs_len, nread_ptr) => {
                if (fd !== 0 || !memRef) return 8;
                const view = new DataView(memRef.buffer);
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
                return 0;
            },
            proc_exit: (code) => {
                if (code !== 0) this.exitCode = code;
                throw { _wasmExit: true, code };
            },
            args_sizes_get: (argc_ptr, buf_size_ptr) => {
                if (!memRef) return 28;
                const args = [this.script, ...(this.arguments || [])];
                const view = new DataView(memRef.buffer);
                view.setUint32(argc_ptr, args.length, true);
                view.setUint32(buf_size_ptr, args.reduce((s, a) => s + a.length + 1, 0), true);
                return 0;
            },
            args_get: (argv_ptr, buf_ptr) => {
                if (!memRef) return 28;
                const args = [this.script, ...(this.arguments || [])];
                const view = new DataView(memRef.buffer);
                const enc = new TextEncoder();
                let offset = buf_ptr;
                for (let i = 0; i < args.length; i++) {
                    view.setUint32(argv_ptr + i * 4, offset, true);
                    const encoded = enc.encode(args[i] + '\0');
                    new Uint8Array(memRef.buffer).set(encoded, offset);
                    offset += encoded.length;
                }
                return 0;
            },
            environ_sizes_get: (cnt, sz) => {
                if (memRef) {
                    const view = new DataView(memRef.buffer);
                    view.setUint32(cnt, 0, true);
                    view.setUint32(sz, 0, true);
                }
                return 0;
            },
            environ_get: () => 0,
            clock_time_get: (id, prec, time_ptr) => {
                if (memRef) {
                    const ns = BigInt(Date.now()) * 1_000_000n;
                    new DataView(memRef.buffer).setBigUint64(time_ptr, ns, true);
                }
                return 0;
            },
            fd_close: () => 0,
            fd_seek: () => 70,       // ESPIPE—no seekable fds
            fd_prestat_get: () => 8, // EBADF—no pre-opened dirs
            fd_prestat_dir_name: () => 8,
            path_open: () => 76,     // ENOTDIR
            random_get: (buf_ptr, buf_len) => {
                if (memRef) {
                    const arr = new Uint8Array(memRef.buffer, buf_ptr, buf_len);
                    for (let i = 0; i < buf_len; i++) arr[i] = Math.random() * 256 | 0;
                }
                return 0;
            },
        };

        const wasiProxy = new Proxy(wasi, { get(t, k) { return k in t ? t[k] : () => 0; } });

        const imports = {
            wasi_snapshot_preview1: wasiProxy,
            wasi_unstable: wasiProxy,
            env: new Proxy({
                // Simple non-WASI imports for hand-written modules
                print: (ptr, len) => { if (memRef) writeFd(1, decoder.decode(new Uint8Array(memRef.buffer, ptr, len))); },
                eprint: (ptr, len) => { if (memRef) writeFd(2, decoder.decode(new Uint8Array(memRef.buffer, ptr, len))); },
                abort: () => { this.exitCode = 134; throw { _wasmExit: true, code: 134 }; },
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
        }

        flushFd();
    }
}

module.exports = WasmCommand;

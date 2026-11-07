'use strict';

const LocalCommand = require('../local/LocalCommand');
const WasmCommand = require('../WasmCommand');
const {
    readBytesFromFs,
    writeBytesToFs,
    loadModule
} = require('./utils');

// Shared cache of downloaded .wasm binaries across invocations
const wasmByteCache = new Map();

/**
 * Pure generic non-interactive WASM & CLI Command builder for WBT (`wbt`).
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
 * Interactive REPL support is provided separately by `ReplCommand` (`lib/wbt/ReplCommand.js`),
 * which extends `createGenericWasmCommand` for packages configured with `repl` in `registry.js`.
 */
function createGenericWasmCommand(pkgMeta, wbtConfig = {}, binNameOverride = null) {
    const binName = (binNameOverride || pkgMeta.bin || pkgMeta.name).toLowerCase();

    class GenericWasmCommand extends LocalCommand {
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

            if (args.includes('--version') || args.includes('-V')) {
                this.stdOut = `${binName} ${pkgMeta.version || 'wasm'}`;
                return;
            }

            try {
                // 1. Direct `.wasm` URL -> fetch and run raw WASI binary via WasmCommand
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

                // 3. Factory / constructor / CLI function (`export default function(opts)` or class)
                if (typeof target === 'function') {
                    await this._runFunctionOrEmscripten(target, args);
                    return;
                }

                // 4. Standard CLI module object (`main`, `run`, `callMain`, `exec`)
                if (target && typeof target === 'object') {
                    if (target.ready) await target.ready;
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
                            if (this.context && this.context.fs) this.context.fs.setMode(targetPath, 0o755);
                            else this.fs.setMode(targetPath, 0o755);
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

        async _runFunctionOrEmscripten(fn, args) {
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

            const ioBridge = this._createIoBridge(args, outLines, errLines);

            let result;
            try {
                // Support both regular factory functions (`await fn(emscriptenConfig, ioBridge)`)
                // and ES6 classes (`new fn(emscriptenConfig)`)
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
                    // Generic virtual-FS CLI runner interface (`load()`, `writeFile()`, `exec()`, `readFile()`)
                    await this._runVirtualFsInstance(result, args, outLines, errLines);
                } else if (typeof result.main === 'function' || typeof result.run === 'function') {
                    const entry = (result.main || result.run).bind(result);
                    await this._invokeCliFunction(entry, args, outLines, errLines);
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
                                if (this.context && this.context.fs) this.context.fs.setMode(arg, 0o755);
                                else this.fs.setMode(arg, 0o755);
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

module.exports = {
    createGenericWasmCommand
};

'use strict';

const Command = require('../Command');
const WasmCommand = require('../WasmCommand');
const { readBytesFromFs, writeBytesToFs, loadModule } = require('./utils');

/**
 * Creates a generic Command class at runtime for ANY WebAssembly / Emscripten / npm package
 * without requiring a hand-written package wrapper.
 *
 * At execution time, it inspects the loaded module or binary and automatically handles:
 * 1. Raw `.wasm` / `.wat` binary (ArrayBuffer / Uint8Array) -> Executes via full WASI `WasmCommand`
 * 2. Emscripten modularized factory (`export default function Module(opts)`) ->
 *    Wires `print` -> `stdOut`, `printErr` -> `stdErr`, `stdin` -> `this.stdin`,
 *    syncs referenced files from `this.fs` into Emscripten's `FS`, runs `callMain(args)` (or `noInitialRun: false`),
 *    and syncs any created/modified files from Emscripten `FS` back into `this.fs`!
 * 3. Standard CLI function / object export (`run(args, io)`, `main(args, io)`, `exec(args)`, or default function) ->
 *    Invokes with CLI arguments and captures return value / stdout / stderr.
 */
function createGenericWasmCommand(pkgMeta, wbtConfig = {}) {
    const binName = (pkgMeta.bin || pkgMeta.name).toLowerCase();

    class GenericWasmCommand extends Command {
        static get name() { return binName; }
        get name() { return binName; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];
            const cdnUrl = pkgMeta.cdnUrl || `https://esm.sh/${pkgMeta.name}`;

            try {
                const loaded = await loadModule(pkgMeta.name, cdnUrl, wbtConfig.moduleLoader);
                const target = (loaded && loaded.default !== undefined) ? loaded.default : loaded;

                // 1. Raw WASM binary (Uint8Array or ArrayBuffer) or WebAssembly.Module
                if (target instanceof Uint8Array || target instanceof ArrayBuffer) {
                    const bytes = target instanceof Uint8Array ? target : new Uint8Array(target);
                    await this._runRawWasmBytes(bytes, args);
                    return;
                }

                // 2. Object with `wasmBytes` or `wasm` buffer
                if (target && (target.wasmBytes instanceof Uint8Array || target.wasm instanceof Uint8Array)) {
                    await this._runRawWasmBytes(target.wasmBytes || target.wasm, args);
                    return;
                }

                // 3. Emscripten modularized factory or CLI function
                if (typeof target === 'function') {
                    await this._runFunctionOrEmscripten(target, loaded, args);
                    return;
                }

                // 4. Object with `callMain`, `main`, `run`, or `exec`
                if (target && typeof target === 'object') {
                    const entryFn = target.main || target.run || target.callMain || target.exec;
                    if (typeof entryFn === 'function') {
                        await this._invokeCliFunction(entryFn.bind(target), args, target);
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
                // Invoke with (emscriptenConfig, ioContext) so both Emscripten factories and generic CLI functions work
                result = await fn(emscriptenConfig, ioContext);
            } catch (err) {
                if (err && typeof err.status === 'number') {
                    this.exitCode = err.status;
                } else {
                    throw err;
                }
            }

            // If `fn` returned an Emscripten module instance with `callMain`
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

        async _invokeCliFunction(fn, args, hostObj) {
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

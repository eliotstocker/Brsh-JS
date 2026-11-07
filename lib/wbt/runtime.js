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
 * Base non-interactive WASM & CLI Command builder for WBT (`wbt`).
 *
 * Executes WebAssembly binaries and CLI modules without any REPL overhead:
 * 1. Direct `.wasm` / `.wat` binary (`pkgMeta.wasmUrl` or raw `Uint8Array` / `ArrayBuffer`) ->
 *    Executes directly via `WasmCommand` with full WASI filesystem (`path_open`, `fd_read`, `fd_write`, etc.).
 * 2. Emscripten modularized CLI (`export default function Module(opts)` with `callMain` & `FS`) ->
 *    Syncs input/output files between `brsh` FS and Emscripten `FS`, wires stdin/stdout/stderr, and calls `callMain(args)`.
 * 3. Standard non-interactive CLI transforms (JSON filter, media transcoder, graph layout, WAT/WASM binary toolkit).
 *
 * Interactive REPL support lives in `ReplCommand` (`lib/wbt/ReplCommand.js`), which extends this
 * base WASM execution model for packages configured with `repl` in `registry.js`.
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

            if (args.includes('--version') || (args.includes('-V') && binName !== 'jq')) {
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

                const mod = loaded || target;

                // 3. Non-interactive CLI module bridges (stdin/file in -> stdout/file out)
                if (this._isJsonFilterModule(target, mod)) {
                    await this._runJsonFilterModule(target, mod, args);
                    return;
                }

                if ((mod && typeof mod.FFmpeg === 'function') || (target && typeof target.FFmpeg === 'function')) {
                    await this._runVirtualFsExecModule(mod.FFmpeg || target.FFmpeg, args);
                    return;
                }

                if (this._isGraphLayoutModule(target, mod)) {
                    await this._runGraphLayoutModule(target, mod, args);
                    return;
                }

                if (this._isWatToolkitModule(target, mod)) {
                    await this._runWatToolkitModule(target, mod, args);
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

        _isJsonFilterModule(target, mod) {
            const obj = target || mod;
            return Boolean(obj && (typeof obj.raw === 'function' || typeof obj.json === 'function'));
        }

        async _runJsonFilterModule(target, mod, args) {
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
                        this.stdErr = `${binName}: ${filePath}: No such file or directory`;
                        this.exitCode = 2;
                        return;
                    }
                    chunks.push(String(content));
                }
                jsonInput = chunks.join('\n');
            } else if (this.stdin !== undefined && this.stdin !== null) {
                jsonInput = String(this.stdin);
            } else {
                this.stdErr = `${binName}: no JSON input provided via file or stdin`;
                this.exitCode = 2;
                return;
            }

            let runner = await Promise.resolve(typeof target === 'function' && !target.raw && !target.json ? target() : (target || mod));
            if (runner && runner.default) runner = await Promise.resolve(runner.default);

            if (runner && typeof runner.raw === 'function') {
                const flags = [];
                if (rawOutput) flags.push('-r');
                if (compactOutput) flags.push('-c');
                if (nullInput) flags.push('-n');
                const out = await runner.raw(jsonInput.trim(), filter, flags);
                if (out !== undefined && out !== null) {
                    String(out).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                }
            } else if (runner && typeof runner.json === 'function') {
                const parsed = JSON.parse(jsonInput.trim());
                const result = await runner.json(parsed, filter);
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

        async _runVirtualFsExecModule(RunnerClass, args) {
            const instance = new RunnerClass();
            const logs = [];
            if (typeof instance.on === 'function') {
                instance.on('log', ({ message }) => {
                    if (message) logs.push(message);
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
                    if (bytes && typeof instance.writeFile === 'function') {
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

            if (code !== 0 && code !== undefined) {
                logs.forEach(l => { this.stdErr = l; });
                this.exitCode = typeof code === 'number' ? code : 1;
            } else if (args.includes('-version') || logs.length > 0) {
                logs.forEach(l => { this.stdOut = l; });
            }
        }

        _isGraphLayoutModule(target, mod) {
            return Boolean(
                (mod && mod.Graphviz && typeof mod.Graphviz.load === 'function') ||
                (target && target.Graphviz && typeof target.Graphviz.load === 'function') ||
                (target && typeof target.layout === 'function')
            );
        }

        async _runGraphLayoutModule(target, mod, args) {
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

            let source = '';
            if (inputFiles.length > 0) {
                const content = this.fs.getFileByPath(inputFiles[0]);
                if (content === null || content === undefined) {
                    this.stdErr = `${binName}: ${inputFiles[0]}: No such file or directory`;
                    this.exitCode = 1;
                    return;
                }
                source = String(content);
            } else if (this.stdin) {
                source = String(this.stdin);
            } else {
                this.stdErr = `${binName}: no input graph provided`;
                this.exitCode = 1;
                return;
            }

            const Provider = (mod && mod.Graphviz) || (target && target.Graphviz) || target;
            const gv = typeof Provider.load === 'function' ? await Provider.load() : Provider;
            const rendered = typeof gv.layout === 'function'
                ? await gv.layout(source, format, engine)
                : await gv.dot(source, format);

            if (outFile) {
                this.fs.setFileByPath(outFile, String(rendered), true);
            } else {
                String(rendered).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
            }
        }

        _isWatToolkitModule(target, mod) {
            return Boolean(binName === 'wat2wasm' || binName === 'wasm2wat' || (target && typeof target.parseWat === 'function'));
        }

        async _runWatToolkitModule(target, mod, args) {
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
            const toolkit = typeof factory === 'function' ? await factory() : (target || mod);

            if (binName === 'wat2wasm') {
                const watSource = this.fs.getFileByPath(inputFile);
                if (watSource === null || watSource === undefined) {
                    this.stdErr = `wat2wasm: ${inputFile}: No such file or directory`;
                    this.exitCode = 1;
                    return;
                }
                const parsed = toolkit.parseWat(inputFile, String(watSource));
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
                const parsed = toolkit.readWasm(bytes, { readDebugNames: true });
                const watText = parsed.toText({ foldExprs: false, inlineExport: false });
                if (outFile) {
                    this.fs.setFileByPath(outFile, watText, true);
                } else {
                    watText.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                }
            }
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

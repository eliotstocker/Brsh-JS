'use strict';

const Command = require('../../Command');
const ReplCommand = require('../ReplCommand');
const { writeBytesToFs, loadModule } = require('../utils');

/**
 * Decodes an AssemblyScript UTF-16 string from linear memory given its pointer.
 * In AssemblyScript's managed object header, `ptr - 4` holds the byte length (rtSize).
 */
function readAsString(memRef, ptr) {
    if (!memRef || !ptr) return '';
    try {
        const buf = memRef.buffer;
        const view = new DataView(buf);
        const byteLength = view.getUint32(ptr - 4, true);
        if (byteLength === 0 || ptr + byteLength > buf.byteLength) return '';
        const u16 = new Uint16Array(buf, ptr, byteLength >>> 1);
        return String.fromCharCode(...u16);
    } catch {
        return `<ptr:${ptr}>`;
    }
}

/**
 * Compiles AssemblyScript source files in memory or to the filesystem using `assemblyscript/asc`.
 */
async function compileWithAsc(asc, args, fs, extraFiles = {}) {
    const stdoutChunks = [];
    const stderrChunks = [];
    const memoryOutputs = {};

    const createMemoryStream = (chunks) => ({
        write(chunk) {
            if (typeof chunk === 'string') {
                chunks.push(chunk);
            } else if (chunk instanceof Uint8Array) {
                chunks.push(new TextDecoder().decode(chunk));
            } else {
                chunks.push(String(chunk));
            }
        }
    });

    const { error, stdout, stderr } = await asc.main(args, {
        stdout: createMemoryStream(stdoutChunks),
        stderr: createMemoryStream(stderrChunks),
        readFile: (filename, baseDir) => {
            if (Object.prototype.hasOwnProperty.call(extraFiles, filename)) {
                return extraFiles[filename];
            }
            const cleanName = filename.replace(/^\.\//, '');
            if (Object.prototype.hasOwnProperty.call(extraFiles, cleanName)) {
                return extraFiles[cleanName];
            }
            if (!fs) return null;
            const relPath = baseDir && baseDir !== '.' && !filename.startsWith('/')
                ? `${baseDir.replace(/\/+$/, '')}/${filename}`
                : filename;
            const content = fs.getFileByPath(relPath) ?? fs.getFileByPath(filename);
            if (content === null || content === undefined) return null;
            return typeof content === 'string' ? content : new TextDecoder().decode(content);
        },
        writeFile: (filename, contents, baseDir) => {
            memoryOutputs[filename] = contents;
            // Don't write internal in-memory runner artifacts (__asrun_out.wasm) to the real/virtual FS
            if (filename.startsWith('__asrun_')) return;
            if (!fs) return;

            const targetPath = baseDir && baseDir !== '.' && !filename.startsWith('/')
                ? `${baseDir.replace(/\/+$/, '')}/${filename}`
                : filename;
            if (contents instanceof Uint8Array || ArrayBuffer.isView(contents)) {
                writeBytesToFs(fs, targetPath, contents, 'application/wasm');
                if (targetPath.endsWith('.wasm')) {
                    try { fs.setMode(targetPath, 0o755); } catch { /* ignore */ }
                }
            } else {
                fs.setFileByPath(targetPath, String(contents), true);
                if (targetPath.endsWith('.wat')) {
                    try { fs.setMode(targetPath, 0o755); } catch { /* ignore */ }
                }
            }
        },
        listFiles: (dirname, baseDir) => {
            if (!fs) return [];
            const targetDir = baseDir && baseDir !== '.' && !dirname.startsWith('/')
                ? `${baseDir.replace(/\/+$/, '')}/${dirname}`
                : dirname;
            const dirObj = fs.getFileByPath(targetDir);
            if (dirObj && typeof dirObj === 'object' && !(dirObj instanceof Uint8Array)) {
                return Object.keys(dirObj);
            }
            return [];
        }
    });

    const outStr = stdoutChunks.join('') || (stdout && typeof stdout.toString === 'function' ? stdout.toString() : '');
    const errStr = stderrChunks.join('') || (stderr && typeof stderr.toString === 'function' ? stderr.toString() : '');

    return { error, outStr, errStr, memoryOutputs };
}

/**
 * Instantiates and executes a compiled AssemblyScript WebAssembly binary with full WASI +
 * AssemblyScript runtime host bindings (`env.abort`, `env.trace`, `env.seed`, `env.log`, `env.logi`, `env.logf`).
 */
async function executeAsWasmBytes(bytes, argv = [], stdinStr = '') {
    const outLines = [];
    const errLines = [];
    const outBuf = { 1: '', 2: '' };
    const decoder = new TextDecoder();
    let memRef = null;
    let exitCode = 0;

    const writeFd = (fd, text) => {
        outBuf[fd] = (outBuf[fd] || '') + text;
        const lines = outBuf[fd].split('\n');
        outBuf[fd] = lines.pop();
        for (const line of lines) {
            if (fd === 1) outLines.push(line);
            else errLines.push(line);
        }
    };

    const flushFd = () => {
        if (outBuf[1]) { outLines.push(outBuf[1]); outBuf[1] = ''; }
        if (outBuf[2]) { errLines.push(outBuf[2]); outBuf[2] = ''; }
    };

    const stdinBytes = new TextEncoder().encode(stdinStr || '');
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
            exitCode = code;
            throw { _wasmExit: true, code };
        },
        args_sizes_get: (argc_ptr, buf_size_ptr) => {
            if (!memRef) return 28;
            const view = new DataView(memRef.buffer);
            view.setUint32(argc_ptr, argv.length, true);
            view.setUint32(buf_size_ptr, argv.reduce((s, a) => s + a.length + 1, 0), true);
            return 0;
        },
        args_get: (argv_ptr, buf_ptr) => {
            if (!memRef) return 28;
            const view = new DataView(memRef.buffer);
            const enc = new TextEncoder();
            let offset = buf_ptr;
            for (let i = 0; i < argv.length; i++) {
                view.setUint32(argv_ptr + i * 4, offset, true);
                const encoded = enc.encode(argv[i] + '\0');
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
        random_get: (buf_ptr, buf_len) => {
            if (memRef) {
                const arr = new Uint8Array(memRef.buffer, buf_ptr, buf_len);
                for (let i = 0; i < buf_len; i++) arr[i] = Math.random() * 256 | 0;
            }
            return 0;
        }
    };

    const wasiProxy = new Proxy(wasi, { get(t, k) { return k in t ? t[k] : () => 0; } });

    const envImports = {
        abort: (msgPtr, filePtr, line, col) => {
            const msg = readAsString(memRef, msgPtr) || 'abort';
            const file = readAsString(memRef, filePtr) || '<as>';
            errLines.push(`abort: ${msg} at ${file}:${line}:${col}`);
            exitCode = 134;
            throw { _wasmExit: true, code: 134 };
        },
        trace: (msgPtr, n, ...args) => {
            const msg = readAsString(memRef, msgPtr);
            const extra = n > 0 ? ' ' + args.slice(0, n).join(', ') : '';
            outLines.push(`trace: ${msg}${extra}`);
        },
        seed: () => Date.now() * Math.random(),
        log: (msgPtr) => {
            outLines.push(readAsString(memRef, msgPtr));
        },
        logi: (val) => {
            outLines.push(String(val));
        },
        logf: (val) => {
            outLines.push(String(val));
        },
        print: (ptr, len) => {
            if (memRef) writeFd(1, decoder.decode(new Uint8Array(memRef.buffer, ptr, len)));
        },
        eprint: (ptr, len) => {
            if (memRef) writeFd(2, decoder.decode(new Uint8Array(memRef.buffer, ptr, len)));
        }
    };

    const imports = {
        wasi_snapshot_preview1: wasiProxy,
        wasi_unstable: wasiProxy,
        env: new Proxy(envImports, { get(t, k) { return k in t ? t[k] : () => 0; } })
    };

    const module = await WebAssembly.compile(bytes);
    for (const imp of WebAssembly.Module.imports(module)) {
        if (imp.kind === 'memory') {
            const mem = new WebAssembly.Memory({ initial: 1, maximum: 256 });
            memRef = mem;
            if (!imports[imp.module]) imports[imp.module] = {};
            imports[imp.module][imp.name] = mem;
        }
    }

    const instance = await WebAssembly.instantiate(module, imports);
    if (instance.exports.memory) memRef = instance.exports.memory;

    const entry = instance.exports._start
        || instance.exports.main
        || instance.exports.run
        || instance.exports.__eval;

    let returnValue = undefined;
    if (typeof entry === 'function') {
        try {
            returnValue = await entry();
        } catch (e) {
            if (!e || !e._wasmExit) {
                errLines.push(`RuntimeError: ${e?.message || String(e)}`);
                exitCode = 1;
            }
        }
    }

    flushFd();
    return { outLines, errLines, returnValue, exitCode, exports: instance.exports, memRef };
}

/**
 * Wraps user AssemblyScript source code with standard prelude helpers (`console.log`, `print`)
 * so that `asrun` feels like `ts-node` / `node` for AssemblyScript.
 */
function buildAsrunSource(userCode, isEvalExpr = false) {
    const prelude = [
        '// --- asrun host prelude ---',
        '@external("env", "log") declare function __host_log(s: string): void;',
        '@external("env", "logi") declare function __host_logi(v: i32): void;',
        '@external("env", "logf") declare function __host_logf(v: f64): void;',
        'namespace console {',
        '  export function log(msg: string): void { __host_log(msg); }',
        '  export function logi(v: i32): void { __host_logi(v); }',
        '  export function logf(v: f64): void { __host_logf(v); }',
        '}',
        ''
    ].join('\n');

    if (isEvalExpr) {
        const trimmed = userCode.trim();
        // If user already wrote `export function` or `console.log`, wrap as top-level `_start` if no export
        if (/\bexport\s+function\b/.test(trimmed)) {
            return `${prelude}\n${trimmed}\n`;
        }
        if (/^(console\.|trace\(|let\s+|const\s+|var\s+|for\s*\(|while\s*\(|if\s*\()/.test(trimmed) || trimmed.includes(';')) {
            return `${prelude}\nexport function _start(): void {\n${trimmed}\n}\n`;
        }
        // Expression returning a number
        return `${prelude}\nexport function __eval(): f64 {\n  return f64(${trimmed});\n}\n`;
    }

    // For a file: if the file doesn't define its own `namespace console`, prepend prelude
    const hasCustomConsole = /\bnamespace\s+console\b/.test(userCode);
    return (hasCustomConsole ? '' : prelude + '\n') + userCode;
}

/**
 * Creates the `asc` compiler command class.
 */
function createAscCommand(pkgMeta, wbtConfig = {}) {
    class AscCommand extends Command {
        static get name() { return pkgMeta.bin || 'asc'; }
        get name() { return pkgMeta.bin || 'asc'; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
                [
                    `Version ${pkgMeta.version} (AssemblyScript WASM Compiler)`,
                    'Syntax: asc [entryFile ...] [options]',
                    '',
                    'Options:',
                    '  -o, --outFile <file>     Specifies the WebAssembly binary output file (.wasm)',
                    '  -t, --textFile <file>    Specifies the WebAssembly text output file (.wat)',
                    '  -O, --optimize           Optimizes the module',
                    '  --version, -v            Prints the compiler version',
                    '',
                    'Tip: Use `asrun <file.ts>` (or `asnode`) to compile & run AssemblyScript directly!'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (args.includes('--version') || args.includes('-v')) {
                this.stdOut = `Version ${pkgMeta.version}`;
                return;
            }

            try {
                const mod = await loadModule('assemblyscript/asc', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
                const asc = mod.default || mod;
                if (asc.ready) await asc.ready;

                const { error, outStr, errStr } = await compileWithAsc(asc, args, this.fs);

                if (outStr.trim()) {
                    outStr.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                }
                if (errStr.trim()) {
                    errStr.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdErr = l; });
                }

                if (error) {
                    if (!errStr.trim()) {
                        this.stdErr = error.message || String(error);
                    }
                    this.exitCode = 1;
                }
            } catch (err) {
                this.stdErr = `asc: ${err.message || err}`;
                this.exitCode = 1;
            }
        }
    }

    return AscCommand;
}

/**
 * Creates the `asrun` / `asnode` command class: a `ts-node` / `node`-style runner and REPL for AssemblyScript.
 */
function createAsRunCommand(pkgMeta, wbtConfig = {}, binName = 'asrun') {
    class AsRunCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
            this._replDeclarations = [];
        }

        _parseArgs(args) {
            let evalCode = null;
            let scriptFile = null;
            const scriptArgs = [];
            let help = false;
            let version = false;

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (!scriptFile && (a === '-h' || a === '--help')) {
                    help = true;
                } else if (!scriptFile && (a === '-v' || a === '--version')) {
                    version = true;
                } else if (!scriptFile && (a === '-e' || a === '--eval') && i + 1 < args.length) {
                    evalCode = args[++i];
                } else if (!scriptFile && !a.startsWith('-')) {
                    scriptFile = a;
                } else if (scriptFile) {
                    scriptArgs.push(a);
                }
            }
            return { evalCode, scriptFile, scriptArgs, help, version };
        }

        shouldBeInteractive() {
            if (this._parsed.help || this._parsed.version) return false;
            if (this._parsed.evalCode !== null || this._parsed.scriptFile !== null) return false;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) return false;
            return true;
        }

        getReplTitle() {
            return `AssemblyScript Runtime REPL (${binName} ${pkgMeta.version})`;
        }

        getReplPrompt() {
            return 'as> ';
        }

        getReplWelcome() {
            return [
                `Welcome to ${binName} (AssemblyScript v${pkgMeta.version} JIT/AOT WebAssembly Runner)`,
                `Type AssemblyScript expressions, functions, or console.log("...") to compile & run in WASM.`,
                `Type ".exit" or Ctrl+D to quit.`
            ];
        }

        async _loadAsc() {
            if (!this._asc) {
                const mod = await loadModule('assemblyscript/asc', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
                const asc = mod.default || mod;
                if (asc.ready) await asc.ready;
                this._asc = asc;
            }
            return this._asc;
        }

        async _compileAndRunSnippet(sourceCode, isEvalExpr = false, argv = []) {
            const asc = await this._loadAsc();
            const virtualEntry = '__asrun_entry.ts';
            const virtualOut = '__asrun_out.wasm';
            const wrapped = buildAsrunSource(sourceCode, isEvalExpr);

            const { error, errStr, memoryOutputs } = await compileWithAsc(
                asc,
                [virtualEntry, '-o', virtualOut],
                this.fs,
                { [virtualEntry]: wrapped }
            );

            if (error || !memoryOutputs[virtualOut]) {
                throw new Error((errStr || error?.message || 'AssemblyScript compilation failed').trim());
            }

            const wasmBytes = memoryOutputs[virtualOut] instanceof Uint8Array
                ? memoryOutputs[virtualOut]
                : new Uint8Array(memoryOutputs[virtualOut]);

            return executeAsWasmBytes(wasmBytes, argv, this.stdin || '');
        }

        async initRepl() {
            await this._loadAsc();
        }

        async evaluateReplLine(line) {
            const trimmed = line.trim();
            if (!trimmed) return { output: [] };

            // Allow defining persistent helper functions in the REPL session
            if (/^(export\s+)?function\s+\w+/.test(trimmed)) {
                const decl = trimmed.startsWith('export ') ? trimmed : `export ${trimmed}`;
                this._replDeclarations.push(decl);
                return { output: [`[Defined function in WASM module]`] };
            }

            const combined = [
                ...this._replDeclarations,
                trimmed
            ].join('\n');

            const isStmt = /^(console\.|trace\(|let\s+|const\s+|var\s+)/.test(trimmed) || trimmed.endsWith(';');
            const fullSource = isStmt
                ? [...this._replDeclarations, `export function _start(): void { ${trimmed} }`].join('\n')
                : [...this._replDeclarations, `export function __eval(): f64 { return f64(${trimmed}); }`].join('\n');

            try {
                const res = await this._compileAndRunSnippet(fullSource, true, [binName]);
                const output = [...res.outLines];
                if (res.errLines.length > 0) {
                    return { output, error: res.errLines.join('\n') };
                }
                if (res.returnValue !== undefined && !isStmt) {
                    output.push(String(res.returnValue));
                }
                return { output };
            } catch (err) {
                // Fallback: try compiling raw combined code
                try {
                    const res = await this._compileAndRunSnippet(combined, true, [binName]);
                    const output = [...res.outLines];
                    if (res.returnValue !== undefined) output.push(String(res.returnValue));
                    return { output, error: res.errLines.join('\n') || undefined };
                } catch {
                    return { error: err.message || String(err) };
                }
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    `Usage: ${binName} [options] [script.ts] [arguments]`,
                    '',
                    'Compiles and immediately executes AssemblyScript (.ts) in WebAssembly (like ts-node / node).',
                    '',
                    'Options:',
                    '  -e, --eval <code>    Evaluate inline AssemblyScript code and print result',
                    '  -v, --version        Print AssemblyScript runtime version',
                    '  -h, --help           Print this help message'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (this._parsed.version) {
                this.stdOut = `${binName} v${pkgMeta.version} (AssemblyScript WASM Runtime)`;
                return;
            }

            try {
                let source = '';
                let isEval = false;
                let argv = [binName];

                if (this._parsed.scriptFile) {
                    const content = this.fs.getFileByPath(this._parsed.scriptFile);
                    if (content == null) {
                        this.stdErr = `${binName}: cannot open '${this._parsed.scriptFile}': No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    source = typeof content === 'string' ? content : new TextDecoder().decode(content);
                    argv = [this._parsed.scriptFile, ...this._parsed.scriptArgs];
                } else if (this._parsed.evalCode !== null) {
                    source = this._parsed.evalCode;
                    isEval = true;
                } else if (this.stdin !== undefined && this.stdin !== null) {
                    source = String(this.stdin);
                    isEval = true;
                }

                const res = await this._compileAndRunSnippet(source, isEval, argv);
                res.outLines.forEach(l => { this.stdOut = l; });
                res.errLines.forEach(l => { this.stdErr = l; });
                if (res.outLines.length === 0 && res.returnValue !== undefined) {
                    this.stdOut = String(res.returnValue);
                }
                if (res.exitCode !== 0) {
                    this.exitCode = res.exitCode;
                }
            } catch (err) {
                const msg = err.message || String(err);
                msg.split(/\r?\n/).forEach(l => { this.stdErr = l; });
                this.exitCode = 1;
            }
        }
    }

    return AsRunCommand;
}

module.exports = createAscCommand;
module.exports.createAscCommand = createAscCommand;
module.exports.createAsRunCommand = createAsRunCommand;

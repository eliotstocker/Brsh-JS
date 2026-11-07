'use strict';

const ReplCommand = require('../ReplCommand');
const { loadModule } = require('../utils');

let cachedPyodide = null;

function createPythonCommand(pkgMeta, wbtConfig = {}, binName = 'python3') {
    class PythonCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
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
                } else if (!scriptFile && (a === '-V' || a === '--version' || a === '-v')) {
                    version = true;
                } else if (!scriptFile && a === '-c' && i + 1 < args.length) {
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
            return `Python ${pkgMeta.version} WASM (Pyodide)`;
        }

        getReplPrompt() {
            return '>>> ';
        }

        getReplWelcome() {
            return [
                `Python ${pkgMeta.version} (Pyodide WebAssembly) on brsh`,
                `Type "help", "copyright", or ".exit" to quit.`
            ];
        }

        async _initPython() {
            if (!cachedPyodide || wbtConfig.moduleLoader) {
                const mod = await loadModule('pyodide', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
                const loadPyodide = mod.loadPyodide || (mod.default && mod.default.loadPyodide) || mod.default || mod;
                if (typeof loadPyodide === 'function') {
                    cachedPyodide = await loadPyodide({
                        indexURL: pkgMeta.indexURL || 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/'
                    });
                } else {
                    cachedPyodide = loadPyodide;
                }
            }
            this._py = cachedPyodide;
            this._stdoutLines = [];
            this._stderrLines = [];

            if (typeof this._py.setStdout === 'function') {
                this._py.setStdout({
                    batched: (str) => {
                        this._stdoutLines.push(str);
                    }
                });
            }
            if (typeof this._py.setStderr === 'function') {
                this._py.setStderr({
                    batched: (str) => {
                        this._stderrLines.push(str);
                    }
                });
            }
        }

        async _runPythonCode(code) {
            this._stdoutLines = [];
            this._stderrLines = [];
            const fn = this._py.runPythonAsync ? this._py.runPythonAsync.bind(this._py) : this._py.runPython.bind(this._py);
            const res = await fn(code);
            return {
                stdout: [...this._stdoutLines],
                stderr: [...this._stderrLines],
                result: res
            };
        }

        async initRepl() {
            await this._initPython();
        }

        async evaluateReplLine(line) {
            if (!line.trim()) return { output: [] };
            try {
                const { stdout, stderr, result } = await this._runPythonCode(line);
                const output = [...stdout];
                if (result !== undefined && result !== null) {
                    output.push(String(result));
                }
                return {
                    output,
                    error: stderr.length > 0 ? stderr.join('\n') : undefined
                };
            } catch (err) {
                return { error: err.message || String(err) };
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    `usage: ${binName} [option] ... [-c cmd | file] [arg] ...`,
                    'Options and arguments:',
                    '  -c cmd : program passed in as string (terminates option list)',
                    '  -V     : print the Python version number and exit',
                    '  -h     : print this help message and exit'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (this._parsed.version) {
                this.stdOut = `Python ${pkgMeta.version}`;
                return;
            }

            try {
                await this._initPython();

                let code = '';
                if (this._parsed.scriptFile) {
                    const content = this.fs.getFileByPath(this._parsed.scriptFile);
                    if (content == null) {
                        this.stdErr = `${binName}: can't open file '${this._parsed.scriptFile}': [Errno 2] No such file or directory`;
                        this.exitCode = 2;
                        return;
                    }
                    code = typeof content === 'string' ? content : new TextDecoder().decode(content);
                } else if (this._parsed.evalCode !== null) {
                    code = this._parsed.evalCode;
                } else if (this.stdin !== undefined && this.stdin !== null) {
                    code = String(this.stdin);
                }

                const { stdout, stderr, result } = await this._runPythonCode(code);
                stdout.forEach(l => { this.stdOut = l; });
                stderr.forEach(l => { this.stdErr = l; });
                if (stdout.length === 0 && result !== undefined && result !== null && this._parsed.evalCode !== null) {
                    this.stdOut = String(result);
                }
            } catch (err) {
                this.stdErr = err.message || String(err);
                this.exitCode = 1;
            }
        }
    }

    return PythonCommand;
}

module.exports = createPythonCommand;

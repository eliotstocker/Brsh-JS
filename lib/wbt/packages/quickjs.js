'use strict';

const ReplCommand = require('../ReplCommand');
const { loadModule } = require('../utils');

function createQuickJsCommand(pkgMeta, wbtConfig = {}) {
    class QuickJsCommand extends ReplCommand {
        static get name() { return pkgMeta.bin || 'qjs'; }
        get name() { return pkgMeta.bin || 'qjs'; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
        }

        _parseArgs(args) {
            let evalCode = null;
            let scriptFile = null;
            let help = false;
            let version = false;

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-h' || a === '--help') {
                    help = true;
                } else if (a === '-v' || a === '--version') {
                    version = true;
                } else if ((a === '-e' || a === '--eval') && i + 1 < args.length) {
                    evalCode = args[++i];
                } else if (!a.startsWith('-') && !scriptFile) {
                    scriptFile = a;
                }
            }
            return { evalCode, scriptFile, help, version };
        }

        shouldBeInteractive() {
            if (this._parsed.help || this._parsed.version) return false;
            if (this._parsed.evalCode !== null || this._parsed.scriptFile !== null) return false;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) return false;
            return true;
        }

        getReplTitle() {
            return `QuickJS WASM (${pkgMeta.version})`;
        }

        getReplPrompt() {
            return 'qjs > ';
        }

        getReplWelcome() {
            return [
                `QuickJS-Emscripten WASM (${pkgMeta.version})`,
                `Type JavaScript expressions or ".exit" to quit.`
            ];
        }

        async _initQuickJs() {
            const mod = await loadModule('quickjs-emscripten', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
            const getQuickJS = mod.getQuickJS || (mod.default && mod.default.getQuickJS) || mod.default || mod;
            this._qjs = typeof getQuickJS === 'function' ? await getQuickJS() : getQuickJS;
            this._vm = this._qjs.newContext();
            this._installConsole(this._vm);
        }

        _installConsole(vm) {
            this._consoleLogLines = [];
            if (!vm.newFunction || !vm.newObject) return;
            const logFn = vm.newFunction('log', (...args) => {
                const parts = args.map(h => vm.dump(h));
                this._consoleLogLines.push(parts.map(p => typeof p === 'object' ? JSON.stringify(p) : String(p)).join(' '));
            });
            const consoleObj = vm.newObject();
            vm.setProp(consoleObj, 'log', logFn);
            vm.setProp(vm.global, 'console', consoleObj);
            logFn.dispose();
            consoleObj.dispose();
        }

        _evalInVm(code, filename = 'eval.js') {
            this._consoleLogLines = [];
            if (typeof this._qjs.evalCode === 'function' && !this._vm.evalCode) {
                const val = this._qjs.evalCode(code);
                return { logs: [...this._consoleLogLines], value: val };
            }
            const result = this._vm.evalCode(code, filename);
            if (result && typeof result === 'object' && ('value' in result || 'error' in result)) {
                if (result.error) {
                    const errVal = this._vm.dump ? this._vm.dump(result.error) : result.error;
                    if (result.error.dispose) result.error.dispose();
                    const msg = errVal && errVal.message ? `${errVal.name || 'Error'}: ${errVal.message}` : String(errVal);
                    throw new Error(msg);
                }
                const value = this._vm.dump ? this._vm.dump(result.value) : result.value;
                if (result.value && result.value.dispose) result.value.dispose();
                return { logs: [...this._consoleLogLines], value };
            }
            return { logs: [...this._consoleLogLines], value: result };
        }

        async initRepl() {
            await this._initQuickJs();
        }

        async evaluateReplLine(line) {
            if (!line.trim()) return { output: [] };
            try {
                const { logs, value } = this._evalInVm(line, '<repl>');
                const output = [...logs];
                if (value !== undefined) {
                    output.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
                }
                return { output };
            } catch (err) {
                return { error: err.message || String(err) };
            }
        }

        async cleanupRepl() {
            if (this._vm && typeof this._vm.dispose === 'function') {
                try { this._vm.dispose(); } catch { /* ignore */ }
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    'QuickJS WASM JavaScript Engine',
                    'usage: qjs [options] [file]',
                    '  -e, --eval EXPR    evaluate expression',
                    '  -v, --version      print version'
                ].forEach(l => { this.stdOut = l; });
                return;
            }
            if (this._parsed.version) {
                this.stdOut = `QuickJS WASM ${pkgMeta.version}`;
                return;
            }

            try {
                await this._initQuickJs();

                let code = '';
                let filename = '<eval>';
                if (this._parsed.scriptFile) {
                    const content = this.fs.getFileByPath(this._parsed.scriptFile);
                    if (content == null) {
                        this.stdErr = `qjs: cannot open '${this._parsed.scriptFile}': No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    code = String(content);
                    filename = this._parsed.scriptFile;
                } else if (this._parsed.evalCode !== null) {
                    code = this._parsed.evalCode;
                } else if (this.stdin !== undefined && this.stdin !== null) {
                    code = String(this.stdin);
                }

                const { logs, value } = this._evalInVm(code, filename);
                logs.forEach(l => { this.stdOut = l; });
                if (logs.length === 0 && value !== undefined && this._parsed.evalCode !== null) {
                    this.stdOut = typeof value === 'object' ? JSON.stringify(value) : String(value);
                }
            } catch (err) {
                this.stdErr = err.message || String(err);
                this.exitCode = 1;
            } finally {
                await this.cleanupRepl();
            }
        }
    }

    return QuickJsCommand;
}

module.exports = createQuickJsCommand;

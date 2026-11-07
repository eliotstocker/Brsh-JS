'use strict';

const ReplCommand = require('../ReplCommand');
const { loadModule } = require('../utils');

function createLuaCommand(pkgMeta, wptConfig = {}) {
    class LuaCommand extends ReplCommand {
        static get name() { return pkgMeta.bin || 'lua'; }
        get name() { return pkgMeta.bin || 'lua'; }

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
                } else if (a === '-e' && i + 1 < args.length) {
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
            return `Lua ${pkgMeta.version} WASM`;
        }

        getReplPrompt() {
            return 'lua> ';
        }

        getReplWelcome() {
            return [
                `Lua ${pkgMeta.version} WebAssembly VM`,
                `Enter Lua statements or ".exit" to quit.`
            ];
        }

        async _initLua() {
            const mod = await loadModule('wasmoon', pkgMeta.cdnUrl, wptConfig.moduleLoader);
            const LuaFactory = mod.LuaFactory || (mod.default && mod.default.LuaFactory) || mod.default || mod;
            const factory = typeof LuaFactory === 'function' ? new LuaFactory() : LuaFactory;
            this._lua = await factory.createEngine();
            this._printLines = [];
            if (this._lua.global && typeof this._lua.global.set === 'function') {
                this._lua.global.set('print', (...args) => {
                    this._printLines.push(args.map(a => String(a ?? 'nil')).join('\t'));
                });
            }
        }

        async initRepl() {
            await this._initLua();
        }

        async evaluateReplLine(line) {
            if (!line.trim()) return { output: [] };
            this._printLines = [];
            try {
                let res;
                try {
                    res = await this._lua.doString(`return ${line}`);
                } catch {
                    res = await this._lua.doString(line);
                }
                const output = [...this._printLines];
                if (res !== undefined && res !== null) {
                    output.push(String(res));
                }
                return { output };
            } catch (err) {
                return { error: err.message || String(err) };
            }
        }

        async cleanupRepl() {
            if (this._lua && typeof this._lua.global?.close === 'function') {
                try { this._lua.global.close(); } catch { /* ignore */ }
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    `usage: lua [options] [script [args]]`,
                    'Available options are:',
                    '  -e stat   execute string \'stat\'',
                    '  -v        show version information'
                ].forEach(l => { this.stdOut = l; });
                return;
            }
            if (this._parsed.version) {
                this.stdOut = `Lua ${pkgMeta.version} (WASM)`;
                return;
            }

            try {
                await this._initLua();
                let code = '';
                if (this._parsed.scriptFile) {
                    const content = this.fs.getFileByPath(this._parsed.scriptFile);
                    if (content == null) {
                        this.stdErr = `lua: cannot open ${this._parsed.scriptFile}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    code = String(content);
                } else if (this._parsed.evalCode !== null) {
                    code = this._parsed.evalCode;
                } else if (this.stdin !== undefined && this.stdin !== null) {
                    code = String(this.stdin);
                }

                this._printLines = [];
                await this._lua.doString(code);
                this._printLines.forEach(l => { this.stdOut = l; });
            } catch (err) {
                this.stdErr = `lua: ${err.message || err}`;
                this.exitCode = 1;
            } finally {
                await this.cleanupRepl();
            }
        }
    }

    return LuaCommand;
}

module.exports = createLuaCommand;

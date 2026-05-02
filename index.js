'use strict';

const EventEmitter = require('events');

const Context = require('./lib/Context');
const LocalCommand = require('./lib/local/LocalCommand');
const ScriptCommand = require('./lib/ScriptCommand');
const Command = require('./lib/Command');

const builtins = require('./lib/builtins');
const localCommands = require('./lib/local');

const variableRegex = /\${?([\w\d]+)}?/g;

//shims etc
String.prototype.regexIndexOf = function(regex, startpos) {
    const indexOf = this.substring(startpos || 0).search(regex);
    return (indexOf >= 0) ? (indexOf + (startpos || 0)) : indexOf;
};
require('string.prototype.matchall').shim();

class Shell extends EventEmitter {
    constructor(options) {
        super();
        const {path = '/bin', profile, hostname = 'browser', filesystem = {}, cwd = '/'} = options;

        this.context = new Context(Object.assign({}, options, {
            clearFn: this.clear.bind(this),
            destroyFn: this.destroy.bind(this)
        }));

        this.context.setVar('PATH', path);
        this.context.setVar('HOST', hostname);
        this.context.setFilesystem(filesystem);
        this.context.setCwd(cwd);

        this._loadDefaultCommands();
        this._loadBuiltinCommands();

        this._lastCode = 0;

        if(profile) {
            this._loadProfile(profile);
        } else {
            setTimeout(() => this.emit('status', Shell.STATUS_READY), 0);
        }
    }

    get path() {
        return this.context.getVar('PATH');
    }

    set lastCode(code) {
        this.context.setVar('?', code);
        this._lastCode = code;
    }

    get lastCode() {
        return this._lastCode;
    }

    onInput(char) {
        if(this.runningCommand && this.runningCommand.onInput && this.runningCommand.captureInput) {
            this.runningCommand.onInput(char);
            return true;
        }
    }

    _loadDefaultCommands() {
        localCommands.forEach(command => {
            this.context.setCommand(command);
        });
    }

    _loadBuiltinCommands() {
        builtins.forEach(command => {
            this.context.setCommand(command);
        });
    }

    _loadProfile(profile) {
        this.onCommand(`source ${profile}`);
    }

    onCommand(raw, events = true) {
        const segments = this._splitInput(raw);
        let shouldRun = true;

        const promise = segments.reduce((chain, { command, op }) => {
            return chain.then(() => {
                if (!shouldRun) {
                    if (op === '&&') shouldRun = this._lastCode === 0;
                    else if (op === '||') shouldRun = this._lastCode !== 0;
                    else if (op === ';') shouldRun = true;
                    return;
                }
                return this._runCommand(command).then(() => {
                    if (op === '&&') shouldRun = this._lastCode === 0;
                    else if (op === '||') shouldRun = this._lastCode !== 0;
                    else if (op === ';') shouldRun = true;
                });
            });
        }, Promise.resolve());

        if(events) {
            return promise.then(() => {
                if(!this.destroyed) {
                    this.emit('status', Shell.STATUS_READY);
                }
            })
                .catch(() => this.emit('status', Shell.STATUS_READY));
        }

        return promise;
    }

    tabCompletion(path) {
        return this.context.fs.autoComplete(path, this.path);
    }

    async _runCommand(command) {
        if(!command || command.length < 1) {
            return;
        }

        this.emit('status', Shell.STATUS_WORKING);

        let args;
        try {
            args = await this._parseCommandLine(command);
        } catch(e) {
            this.emit('stdErr', e.message || String(e));
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return;
        }

        if (!args.length) return;
        let bin = args.shift();

        //short circuit for aliases
        const alias = this.context.getAlias(bin);
        if(alias) {
            return this.onCommand(alias, false);
        }

        let Cmd;
        try {
            Cmd = this._parseCommand(bin.toLowerCase());
        } catch(e) {
            this.emit('stdErr', e.message);
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return;
        }

        let instance;
        if(Cmd.prototype instanceof LocalCommand || new Cmd() instanceof ScriptCommand) {
            instance = new Cmd(args, this.context);
        } else if(Cmd.prototype instanceof Command) {
            instance = new Cmd(args);
        } else {
            this.emit('stdErr', `${bin}: Command not found`);
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return;
        }

        if(instance.requiresFilesystem) {
            instance.fs = this.context.fs;
        }

        this.runningCommand = instance;
        if(this.runningCommand.on) {
            this.runningCommand.on('flush', lines => {
                this._emitOutput(lines);
            });
        }

        return instance.runCommand().then(result => {
            this._emitOutput(result.getStdOutput());
            this.lastCode = result.getExitCode();
            this.emit('exitCode', this.lastCode);
            delete this.runningCommand;
        });
    }

    _emitOutput(lines) {
        lines.forEach(({type, string}) => {
            if(type === 'out') {
                this.emit('stdOut', string);
            } else if(type === 'err') {
                this.emit('stdErr', string);
            }
        });
    }

    getPrompt() {
        const path = this.context.fs.cwd.split('/');
        return `${this.context.getVar('HOST')}:${path[path.length -2]}$`;
    }

    destroy(code = 0) {
        if(!this.destroyed) {
            this.destroyed = true;
            this.emit('status', Shell.STATUS_DESTROYED);
            this.emit('exit', code);
        }
    }

    clear() {
        this.emit('clear');
    }

    _splitInput(input) {
        const commentStripped = input.split('#')[0];
        return this._parseOperators(commentStripped);
    }

    _parseOperators(input) {
        const segments = [];
        let current = '';
        let i = 0;
        let sq = false, dq = false;

        while (i < input.length) {
            const ch = input[i];
            if (ch === "'" && !dq) { sq = !sq; current += ch; i++; continue; }
            if (ch === '"' && !sq) { dq = !dq; current += ch; i++; continue; }
            if (!sq && !dq) {
                if (ch === '&' && input[i + 1] === '&') {
                    segments.push({ command: current.trim(), op: '&&' });
                    current = ''; i += 2; continue;
                }
                if (ch === '|' && input[i + 1] === '|') {
                    segments.push({ command: current.trim(), op: '||' });
                    current = ''; i += 2; continue;
                }
                if (ch === ';') {
                    segments.push({ command: current.trim(), op: ';' });
                    current = ''; i++; continue;
                }
            }
            current += ch; i++;
        }
        if (current.trim()) segments.push({ command: current.trim(), op: null });
        return segments;
    }

    _parseCommand(command) {
        if(command.startsWith('./') || command.startsWith('/')) {
            const handle = this.context.fs.getFileByPath(command);
            if(!handle) {
                throw new Error(`${command}: No such file or directory`);
            }

            if(handle.constructor === Object) {
                throw new Error(`${command}: is a directory`);
            }

            if(handle.prototype && handle.prototype instanceof Command) {
                return handle;
            }

            if(handle.constructor === String && handle.startsWith('#!')) {
                return ScriptCommand.bind(this, handle);
            }

            throw new Error(`${command}: permission denied`);
        }
        const cmd = this.context.getCommand(command);

        if(!cmd) {
            throw new Error(`${command}: Command not found`);
        }

        return cmd;
    }

    async _parseCommandLine(string) {
        const parts = Shell._splitCommand(string);
        const replaced = await Promise.all(
            parts.map(({ value, hasQuote }) =>
                this._replaceVariables(value).then(v => ({ value: v, hasQuote }))
            )
        );
        // Keep tokens that are non-empty OR were explicitly quoted (preserves "" → '')
        return replaced
            .filter(({ value, hasQuote }) => value.length > 0 || hasQuote)
            .map(({ value }) => value);
    }

    static _sanitiseCommandPart(string) {
        return (string.startsWith('"') && string.endsWith('"'))
            || (string.startsWith('\'') && string.endsWith('\''))
            ? string.substring(1, string.length - 1) : string;
    }

    static _sanitiseArray(array) {
        return array.filter(item => item.length > 0);
    }

    async _replaceVariables(part) {
        // 1. Arithmetic substitution $(( expr ))
        const arithMatches = [...part.matchAll(/\$\(\(([^)]+)\)\)/g)];
        for (const m of arithMatches) {
            part = part.replace(m[0], String(this._evalArithmetic(m[1])));
        }

        // 2. Command substitution $( cmd ) — negative lookahead excludes $((
        const cmdMatches = [...part.matchAll(/\$\((?!\()([^)]+)\)/g)];
        for (const m of cmdMatches) {
            const output = await this._runAndCapture(m[1]);
            part = part.replace(m[0], output);
        }

        // 3. Variable substitution $VAR and ${VAR}
        const matches = part.matchAll(variableRegex);
        let match = matches.next();
        while (!match.done) {
            const value = this.context.getVar(match.value[1]);
            part = part.replace(new RegExp(Shell._escapeRegExp(match.value[0]), 'g'), String(value));
            match = matches.next();
        }

        return part;
    }

    _evalArithmetic(expr) {
        const expanded = expr.replace(/\${?([\w\d]+)}?/g, (m, name) =>
            String(parseInt(this.context.getVar(name)) || 0));
        if (!/^[\d\s+\-*/%()]+$/.test(expanded.trim())) return 0;
        try {
            return new Function('return (' + expanded + ')')();
        } catch {
            return 0;
        }
    }

    async _runAndCapture(cmd) {
        const subshell = new global.shell({
            cwd: this.context.fs.cwd,
            filesystem: this.context.fs.getRaw()
        });
        subshell.context.source(this.context);

        const lines = [];
        subshell.on('stdOut', line => lines.push(line));
        await subshell.onCommand(cmd, false);

        return lines.join('\n').trimEnd();
    }

    // Returns Array<{value: string, hasQuote: boolean}>.
    // hasQuote=true means the token contained an explicit quoted segment (even empty ""),
    // which must be preserved even if the final value is an empty string.
    static _splitCommand(string) {
        const separator = /\s/g;
        let singleQuoteOpen = false;
        let doubleQuoteOpen = false;
        let dollarDepth = 0;
        let tokenBuffer = [];
        let tokenHasQuote = false;
        const parts = [];

        for (let i = 0; i < string.length; i++) {
            const ch = string[i];

            // Inside $(...) or $((...)) — keep everything verbatim, track nesting
            if (dollarDepth > 0) {
                tokenBuffer.push(ch);
                if (ch === '(') dollarDepth++;
                else if (ch === ')') dollarDepth--;
                continue;
            }

            // Quote handling
            if (ch === "'" && !doubleQuoteOpen) {
                singleQuoteOpen = !singleQuoteOpen;
                tokenHasQuote = true;
                continue;
            }
            if (ch === '"' && !singleQuoteOpen) {
                doubleQuoteOpen = !doubleQuoteOpen;
                tokenHasQuote = true;
                continue;
            }

            if (!singleQuoteOpen && !doubleQuoteOpen) {
                // Start of $( or $(( substitution — consume the opening '(' too
                if (ch === '$' && i + 1 < string.length && string[i + 1] === '(') {
                    dollarDepth = 1;
                    tokenBuffer.push('$');
                    tokenBuffer.push('(');
                    i++;
                    continue;
                }

                // Whitespace splits tokens
                if (ch.match(separator)) {
                    if (tokenBuffer.length > 0 || tokenHasQuote) {
                        parts.push({ value: tokenBuffer.join(''), hasQuote: tokenHasQuote });
                        tokenBuffer = [];
                        tokenHasQuote = false;
                    }
                    continue;
                }
            }

            tokenBuffer.push(ch);
        }

        if (tokenBuffer.length > 0 || tokenHasQuote) {
            parts.push({ value: tokenBuffer.join(''), hasQuote: tokenHasQuote });
        }

        if (singleQuoteOpen || doubleQuoteOpen) {
            throw new Error('quote expression not closed');
        }
        return parts;
    }

    static _escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}

Shell.STATUS_READY = 'READY';
Shell.STATUS_WORKING = 'WORKING';
Shell.STATUS_DESTROYED = 'DESTROYED';

Shell.Command = Command;

global.shell = Shell;
module.exports = Shell;

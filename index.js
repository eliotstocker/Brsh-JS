'use strict';

const EventEmitter = require('events');

const Context = require('./lib/Context');
const LocalCommand = require('./lib/local/LocalCommand');
const ScriptCommand = require('./lib/ScriptCommand');
const Command = require('./lib/Command');

const builtins = require('./lib/builtins');
const localCommands = require('./lib/local');
const blocks = require("./lib/blocks");

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

        this.context = new Context(Object.assign({}, options));

        this.context.on('clear', this.clear.bind(this));
        this.context.on('destroy', this.destroy.bind(this));

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
            return this.runningCommand.onInput(char);
        }

        return false;
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
        const commands = this._splitInput(raw);

        const promise = commands.reduce((chain, command) => {
            return chain.then(() => {
                let link = Promise.resolve();
                if(!this._updateCurrentBlock(command)) {
                    link = this._runCommand(command);
                }

                // Dont block input for command blocks that are not complete
                if(this.runningCommand && this.runningCommand.captureLines && this.runningCommand.parsePromise) {
                    return this.runningCommand.parsePromise.then(() => {
                        if (this.runningCommand && !this.runningCommand.blockComplete) {
                            return Promise.resolve();
                        }
                        return link;
                    })
                }

                return link;
            })
                .then(() => {
                    if(this._lastCode > 0) {
                        throw new Error('chain broken');
                    }
                }).catch(e => {
                    console.error(e);
                })
        }, Promise.resolve());

        if(events) {
            return promise.then(() => {
                if(!this.destroyed) {
                    if(this.runningCommand && this.runningCommand.captureLines && !this.runningCommand.blockComplete) {
                        return this.emit('status', Shell.STATUS_INTERACTIVE);
                    }
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

    _runCommand(command) {
        if(command.length < 1) {
            return Promise.resolve();
        }

        const block = this._parseBlock(command);

        if(block) {
            return this._runBlock(block, command);
        }

        this.emit('status', Shell.STATUS_WORKING);

        let args = this._parseCommandLine(command);
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
            return Promise.resolve();
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
            return Promise.resolve();
        }

        if(instance.requiresFilesystem) {
            instance.fs = this.context.fs;
        }

        this.runningCommand = instance;
        if(this.runningCommand.on) {
            this.runningCommand.on('flush', lines => {
                this._emitOutput(lines);
            })
        }

        return instance.runCommand().then(result => {
            this._emitOutput(result.getStdOutput());
            this.lastCode = result.getExitCode();
            this.emit('exitCode', this.lastCode);
            delete this.runningCommand;
        });
    }

    _runBlock(block, command) {
        this.runningCommand = new block(command, this.context);

        if(this.runningCommand.on) {
            this.runningCommand.on('flush', lines => {
                this._emitOutput(lines);
            })
        }

        return this.runningCommand.runBlock().then(result => {
            this._emitOutput(result.getStdOutput());
            this.lastCode = result.getExitCode();
            this.emit('exitCode', this.lastCode);
            delete this.runningCommand;
        });
    }

    _updateCurrentBlock(line) {
        if(this.runningCommand && this.runningCommand.captureLines && !this.runningCommand.blockComplete) {
            this.runningCommand.onLine(line);
            return true;
        }
        return false;
    }

    _parseBlock(command) {
        return blocks.find(blockType => blockType.matchBlock(command));
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
        if(this.runningCommand) {
            return ">"
        }
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
        // remove anything after hash as its a comment;
        let out = [input.split('#')[0]];

        return out
            .flatMap(item => item.split('&&'))
            .flatMap(item => item.split(';'))
            .flatMap(item => item.trim());
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

    _parseCommandLine(string) {
        const parts = Shell._sanitiseArray(Shell._splitCommand(string));
        const replaced = parts.map(part => this._replaceVariables(part));

        return Shell._sanitiseArray(replaced);
    }

    static _sanitiseCommandPart(string) {
        return (string.startsWith('"') && string.endsWith('"'))
            || (string.startsWith('\'') && string.endsWith('\''))
            ? string.substring(1, string.length - 1) : string;
    }

    static _sanitiseArray(array) {
        return array.filter(item => item.length > 0);
    }

    _replaceVariables(part) {
        return Shell.replaceVariables(this.context, part);
    }

    static replaceVariables(context, part, defaultVal = '') {
        const matches = part.matchAll(variableRegex);

        let match = matches.next();
        while (!match.done) {
            const value = context.getVar(match.value[1], defaultVal);
            part = part.replace(new RegExp(Shell._escapeRegExp(match.value[0]), 'g'), value);
            match = matches.next();
        }

        return part;
    }

    static _splitCommand(string) {
        const separator = /\s/g;
        let singleQuoteOpen = false;
        let doubleQuoteOpen = false;
        let tokenBuffer = [];
        const parts = [];

        for (let character of string) {
            const matches = character.match(separator);
            if (character === "'" && !doubleQuoteOpen) {
                singleQuoteOpen = !singleQuoteOpen;
                continue;
            } else if (character === '"' && !singleQuoteOpen) {
                doubleQuoteOpen = !doubleQuoteOpen;
                continue;
            }

            if (!singleQuoteOpen && !doubleQuoteOpen && matches) {
                if (tokenBuffer.length > 0) {
                    parts.push(tokenBuffer.join(''));
                    tokenBuffer = [];
                }
            } else {
                tokenBuffer.push(character);
            }
        }
        if (tokenBuffer.length > 0) {
            parts.push(tokenBuffer.join(''));
        }

        if(singleQuoteOpen || doubleQuoteOpen) {
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
Shell.STATUS_INTERACTIVE = 'WORKING_INTERACTIVE';
Shell.STATUS_DESTROYED = 'DESTROYED';

Shell.Command = Command;

global.shell = Shell;
module.exports = Shell;
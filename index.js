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

        this.context = new Context();
        this.context.setVar('PATH', path);
        this.context.setVar('HOST', hostname);
        this.context.setFilesystem(filesystem);
        this.context.setCwd(cwd);

        this._loadDefaultCommands();
        this._loadBuiltinCommands();
        this.lastCode = 0;

        if(profile) {
            this.loadProfile(`source ${profile}`);
        } else {
            this.emit('status', 'READY');
        }
    }

    get path() {
        return this.context.getVar('PATH');
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

    loadProfile(profile) {
        this.onCommand(profile);
    }

    onCommand(command) {
        let args = this._parseCommandLine(command);
        let bin = args.shift();

        //short circuit for aliases
        const alias = this.context.getAlias(bin);
        if(alias) {
            return this.onCommand(alias);
        }

        let Cmd;
        try {
            Cmd = this._parseCommand(bin.toLowerCase());
        } catch(e) {
            this.emit('stdErr', e.message);
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return this.emit('status', 'READY');
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
            return this.emit('status', 'READY');
        }

        if(instance.requiresFilesystem) {
            instance.fs = this.context.fs;
        }

        return instance.runCommand().then(result => {
            result.getStdOutput().forEach(line => {
                if(line.type === 'out') {
                    this.emit('stdOut', line.string);
                } else if(line.type === 'err') {
                    this.emit('stdErr', line.string);
                }
            });
            this.lastCode = result.getExitCode();
            this.emit('exitCode', this.lastCode);
            this.emit('status', 'READY');
        });
    }

    getPrompt() {
        const path = this.context.fs.cwd.split('/');
        return `${this.context.getVar('HOST')}:${path[path.length -2]}$`;
    }

    destroy(code) {
        if(!this.destroyed) {
            this.destroyed = true;
            this.emit('exit', code);
        }
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
        const Command = this.context.getCommand(command);

        if(!Command) {
            throw new Error(`${command}: Command not found`);
        }

        return Command;
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
        const matches = part.matchAll(variableRegex);

        let match = matches.next();
        while (!match.done) {
            const value = this.context.getVar(match.value[1]);
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

global.shell = Shell;
module.exports = Shell;
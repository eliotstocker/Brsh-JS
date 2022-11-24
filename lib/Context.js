'use strict';

const FileSystem = require('./FileSystem');
const EventEmitter = require('events');


class Context extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        const {cwd = '/'} = this.options;

        this.vars = {};
        this.functions = {};
        this.aliases = {};
        this.fs = new FileSystem(cwd);
    }

    setVar(variable, val) {
        if(val) {
            this.vars[variable] = val;
        } else {
            delete this.vars[variable];
        }
        this.emit('update');
    }

    unsetVar(variable) {
        if(this.vars[variable]) {
            this.setVar(variable);
        }
        this.emit('update');
    }

    getVar(variable, defaultVal = '') {
        return this.vars[variable] || defaultVal;
    }

    setFunction(name, content) {
        this.functions[name] = content;
        this.emit('update');
    }

    unsetFunction(name) {
        if(this.functions[name]) {
            delete this.functions[name];
            this.emit('update');
        }
    }

    getFunction(name) {
        return this.functions[name];
    }

    setAlias(alias, cmd) {
        if(cmd) {
            this.aliases[alias] = cmd;
        } else {
            delete this.aliases[alias];
        }
        this.emit('update');
    }

    unsetAlias(alias) {
        if(this.aliases[alias]) {
            this.setAlias(alias)
            this.emit('update');
        }
    }

    getAlias(alias) {
        return this.aliases[alias] || null;
    }

    setCommand(command) {
        const path = this.getVar('PATH');
        const location = `${path}/${command.name.toLowerCase()}`;
        this.fs.addFiles({[location]: command});
    }

    getCommand(command) {
        const path = this.getVar('PATH');
        const location = `${path}/${command}`;
        return this.fs.getFileByPath(location) || null;
    }

    setFilesystem(filesystem) {
        const commands = this.fs.getFileByPath(this.getVar('PATH')) || {};
        this.fs = new FileSystem(this.fs.cwd, filesystem);
        this.fs.addFiles(commands);
    }

    setCwd(cwd) {
        this.fs.setCwd(cwd);
    }

    source(context) {
        this.vars = Object.assign({}, this.vars, context.vars);
        this.aliases = Object.assign({}, this.aliases, context.aliases);
    }

    clear() {
        this.emit('clear');
    }

    destroy(code = 0) {
        this.emit('destroy');
    }
}

module.exports = Context;
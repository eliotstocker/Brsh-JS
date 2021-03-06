'use strict';

const FileSystem = require('./FileSystem');

class Context {
    constructor(options) {
        this.options = options;
        const {cwd = '/', clearFn, destroyFn} = this.options;

        this.vars = {};
        this.aliases = {};
        this.fs = new FileSystem(cwd);
        this._clearFn = clearFn;
        this._destroyFn = destroyFn;
    }

    setVar(variable, val) {
        if(val) {
            this.vars[variable] = val;
        } else {
            delete this.vars[variable];
        }
    }

    unsetVar(variable) {
        this.setVar(variable);
    }

    getVar(variable) {
        return this.vars[variable] || '';
    }

    setAlias(alias, cmd) {
        if(cmd) {
            this.aliases[alias] = cmd;
        } else {
            delete this.aliases[alias];
        }
    }

    unsetAlias(alias) {
        this.setAlias(alias)
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
        if(typeof this._clearFn === 'function') {
            this._clearFn();
        }
    }

    destroy(code = 0) {
        if(typeof this._destroyFn === 'function') {
            this._destroyFn(code);
        }
    }
}

module.exports = Context;
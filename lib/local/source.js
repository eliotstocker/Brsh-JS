'use strict';

const ScriptCommand = require('../ScriptCommand');
const LocalCommand = require('./LocalCommand');

const Shell = require('../../index');

class Source extends LocalCommand {
    constructor(args, context) {
        super(args, context);
        if(this.arguments.length !== 1) {
            return Promise.reject('source requires a single argument');
        }

        const script = this.arguments[0];

        if(script.startsWith('./') || script.startsWith('/')) {
            const handle = this.context.fs.getFileByPath(script);

            if (handle && handle.constructor === String && handle.startsWith('#!')) {
                return new ScriptCommand(handle, args, context, true);
            }
        }
    }

    run() {
        const script = this.arguments[0];

        if(script.startsWith('./') || script.startsWith('/')) {
            const handle = this.context.fs.getFileByPath(script);

            if (!handle) {
                return Promise.reject(`${script}: No such file or directory`);
            }

            if (handle.constructor === Object) {
                return Promise.reject(`${script}: is a directory`);
            }

            if (handle.prototype && handle.prototype instanceof Command) {
                return Promise.reject(`${script}: command not found`);
            }

            if (handle.constructor === String && handle.startsWith('#!')) {
                return Promise.reject('FATAL: should not get here');
            }
        }
        return Promise.reject(`${script}: permission denied`);
    }
}

module.exports = Source;
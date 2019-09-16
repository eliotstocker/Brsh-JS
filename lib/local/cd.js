'use strict';

const LocalCommand = require('./LocalCommand');

class CD extends LocalCommand {
    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('cd requires a single argument');
        }

        const handle = this.context.fs.getFileByPath(this.arguments[0]);

        if(!handle) {
            return Promise.reject('file or directory not found');
        }

        if(handle.constructor === Object) {
            this.context.setCwd(this.arguments[0]);
            return Promise.resolve();
        }

        return Promise.reject(`${this.arguments[0]}: Not a directory`);
    }
}

module.exports = CD;
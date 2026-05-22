'use strict';

const LocalCommand = require('./LocalCommand');

class CD extends LocalCommand {
    static get name() { return 'cd'; }

    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('cd requires a single argument');
        }

        const s = this.context.fs.stat(this.arguments[0]);

        if(!s) {
            return Promise.reject('file or directory not found');
        }

        if(s.isDirectory) {
            this.context.setCwd(this.arguments[0]);
            return Promise.resolve();
        }

        return Promise.reject(`${this.arguments[0]}: Not a directory`);
    }
}

module.exports = CD;
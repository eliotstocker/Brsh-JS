'use strict';

const LocalCommand = require('./LocalCommand');

class Which extends LocalCommand {
    static get name() { return 'which'; }

    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('which requires a single argument');
        }

        const cmdPath = `${this.context.getVar('PATH')}/${this.arguments[0]}`;
        const file = this.context.fs.getFileByPath(cmdPath);

        if(!file || file.constructor === Object) {
            return Promise.reject();
        }

        if(file.constructor === String && !file.startsWith('#!') && !this.context.fs.isExecutable(cmdPath)) {
            return Promise.reject();
        }

        return Promise.resolve(cmdPath);
    }
}

module.exports = Which;
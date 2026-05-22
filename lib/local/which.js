'use strict';

const LocalCommand = require('./LocalCommand');

class Which extends LocalCommand {
    static get name() { return 'which'; }

    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('which requires a single argument');
        }

        const file = this.context.fs.getFileByPath(`${this.context.getVar('PATH')}/${this.arguments[0]}`);

        if(!file || file.constructor === Object || file.constructor === String) {
            return Promise.reject();
        }

        return Promise.resolve(`${this.context.getVar('PATH')}/${this.arguments[0]}`);
    }
}

module.exports = Which;
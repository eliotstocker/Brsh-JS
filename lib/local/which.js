'use strict';

const LocalCommand = require('./LocalCommand');

class Which extends LocalCommand {
    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('which requires a single argument');
        }

        const file = this.context.fs.getFileByPath(`${this.context.getVar('PATH')}/${this.arguments[0]}}`);

        if(!file || file.constructor === Object || file.constructor === String) {
            return Promise.reject();
        }

        return Promise.resolve(path);
    }
}

module.exports = Which;
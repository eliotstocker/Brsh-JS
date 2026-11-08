'use strict';

const LocalCommand = require('./LocalCommand');

class Clear extends LocalCommand {
    static get name() { return 'clear'; }

    run() {
        if(this.arguments.length > 0) {
            return Promise.reject('clear does not require arguments');
        }

        if (this.stdout) {
            this.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        }
        this.context.clear();

        return Promise.resolve();
    }
}

module.exports = Clear;
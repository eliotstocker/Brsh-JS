'use strict';

const LocalCommand = require('./LocalCommand');

class Clear extends LocalCommand {
    run() {
        if(this.arguments.length > 0) {
            return Promise.reject('clear does not require arguments');
        }

        this.context.clear();

        return Promise.resolve();
    }
}

module.exports = Clear;
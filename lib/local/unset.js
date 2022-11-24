'use strict';

const LocalCommand = require('./LocalCommand');

class Unset extends LocalCommand {
    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('unset requires a single argument');
        }

        this.context.unsetVar(this.arguments[0]);

        return Promise.resolve();
    }
}

module.exports = Unset;
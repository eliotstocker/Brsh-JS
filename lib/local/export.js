'use strict';

const LocalCommand = require('./LocalCommand');

class Export extends LocalCommand {
    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('export requires a single argument');
        }

        const kv = this.arguments[0].split('=');
        if(kv.length !== 2) {
            Promise.reject('export requires a key and value delimited by \'=\' ie: key=value');
        }

        this.context.setVar(kv[0], kv[1]);

        return Promise.resolve();
    }
}

module.exports = Export;
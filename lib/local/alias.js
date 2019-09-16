'use strict';

const LocalCommand = require('./LocalCommand');

class Alias extends LocalCommand {
    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('alias requires a single argument');
        }

        const kv = this.arguments[0].split('=');
        if(kv.length !== 2) {
            return Promise.reject('alias requires a key and value delimited by \'=\' ie: key=value');
        }

        this.context.setAlias(kv[0], kv[1]);

        return Promise.resolve();
    }
}

module.exports = Alias;
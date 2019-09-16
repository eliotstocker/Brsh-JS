'use strict';

const LocalCommand = require('./LocalCommand');

class Exit extends LocalCommand {
    run() {
        const code = parseInt(this.arguments[0]) || 0;
        this.exitCode = code;
        this.context.destroy(code);
        return Promise.resolve();
    }
}

module.exports = Exit;
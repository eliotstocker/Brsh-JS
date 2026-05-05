'use strict';

const LocalCommand = require('./LocalCommand');

class Pwd extends LocalCommand {
    run() {
        const cwd = this.context.fs.cwd;
        this.stdOut = cwd.endsWith('/') && cwd !== '/' ? cwd.slice(0, -1) : cwd;
        return Promise.resolve();
    }
}

module.exports = Pwd;

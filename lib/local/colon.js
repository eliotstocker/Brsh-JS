'use strict';

const LocalCommand = require('./LocalCommand');

//arguments still get expanded by the shell, which is what makes `: ${VAR:=default}` work
class Colon extends LocalCommand {
    static get name() { return ':'; }

    run() {
        return Promise.resolve();
    }
}

module.exports = Colon;

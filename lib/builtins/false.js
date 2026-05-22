'use strict';

const Command = require('../Command');

class False extends Command {
    static get name() { return 'false'; }
    run() {
        this.exitCode = 1;
        return Promise.resolve();
    }
}

module.exports = False;

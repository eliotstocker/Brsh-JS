'use strict';

const Command = require('../Command');

class True extends Command {
    run() {
        return Promise.resolve();
    }
}

module.exports = True;
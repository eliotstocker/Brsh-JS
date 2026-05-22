'use strict';

const Command = require('../Command');

class True extends Command {
    static get name() { return 'true'; }
    run() { return Promise.resolve(); }
}

module.exports = True;

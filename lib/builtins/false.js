'use strict';

const Command = require('../Command');

class False extends Command {
    run() {
        return Promise.reject();
    }
}

module.exports = False;
'use strict';

const Command = require('../Command');
const Result = require('../Result');

class Echo extends Command {
    run() {
        return Promise.resolve(this.arguments.join(' '));
    }
}

module.exports = Echo;
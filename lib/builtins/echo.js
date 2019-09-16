'use strict';

const Command = require('../Command');
const Result = require('../Result');

class Echo extends Command {
    run() {
        if(this.arguments.length !== 1) {
            Promise.reject('echo command requires a single argument');
        }

        return Promise.resolve(this.arguments[0]);
    }
}

module.exports = Echo;
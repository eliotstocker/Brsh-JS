'use strict';

const Command = require('../Command');

class LocalCommand extends Command {
    constructor(args, context) {
        super(args);
        this.context = context;
    }
}

module.exports = LocalCommand;
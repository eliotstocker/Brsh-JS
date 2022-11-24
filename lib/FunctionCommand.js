'use strict';

const ScriptCommand = require('./ScriptCommand');

class FunctionCommand extends ScriptCommand {
    constructor(script, args, context) {
        super('#!/brsh.js\n' + script, args, context, true);
    }
}

module.exports = FunctionCommand;
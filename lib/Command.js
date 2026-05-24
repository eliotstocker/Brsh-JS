'use strict';

const events = require('events');
const Result = require('./Result');

const EventEmitter = events.EventEmitter || events.default || events;

class Command extends EventEmitter {
    constructor(args) {
        super();
        this.arguments = args;
        this.result = new Result();
    }

    get name() {
        return 'unnamed';
    }

    run() {
        return Promise.reject("Command not implemented...");
    }

    runCommand() {
        return this.run()
            .then(d => {
                if(d) {
                    d.split(/\r?\n/).forEach(line => this.stdOut = line);
                }
                return this.result;
            })
            .catch(e => {
                // Re-throw shell control-flow signals (break, continue, return,
                // errexit) so they propagate correctly through function calls
                // and nested script execution.
                if (e && e.__type) {
                    throw e;
                }
                if(e) {
                    this.stdErr = e.message || e;
                }
                this.exitCode = 127;
                return this.result;
            });
    }

    onInput(char) {
        //ignored by default, can be overridden in a command if needed to get input
    }

    set exitCode(code) {
        this.result.exitCode = code;
    }

    set stdOut(String) {
        this.result.addStdOutLine(String);
    }

    set stdErr(String) {
        this.result.addStdErrLine(String);
    }

    flush() {
        this.emit('flush', this.result.flush());
    }
}

module.exports = Command;

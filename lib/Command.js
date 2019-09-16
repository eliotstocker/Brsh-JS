'use strict';

const Result = require('./Result');

class Command {
    constructor(args) {
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
                    this.stdOut = d;
                }
                return this.result;
            })
            .catch(e => {
                if(e) {
                    this.stdErr = e.message || e;
                }
                this.exitCode = 127;
                return this.result;
            });
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
}

module.exports = Command;

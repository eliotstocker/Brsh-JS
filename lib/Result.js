'use strict';

const StdLine = require('./StdLine');

class Result {
    constructor(std = [], exitCode = 0) {
        if(typeof exitCode != 'number') {
            throw new Error("Command Result ExitCode must be a number");
        }

        if(!Array.isArray(std)) {
            throw new Error("Command Result be array");
        }

        this.std = std;
        this.exitCode = exitCode;
    }

    addStdOutLine(String) {
        this.std.push(new StdLine('out', String));
    }

    addStdErrLine(String) {
        this.std.push(new StdLine('err', String));
    }

    getStdOutput() {
        return this.std;
    }

    getExitCode() {
        return this.exitCode;
    }
}

module.exports = Result;
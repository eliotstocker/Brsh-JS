'use strict';

const EventEmitter = require('events');
const Result = require('./Result');

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
                if(e) {
                    this.stdErr = e.message || e;
                }
                this.exitCode = 127;
                return this.result;
            });
    }

    onInput(char) {
        //ignnored by default, can be overridden in a command if needed to get input
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
        console.log("flush now");
        this.emit('flush', this.result.flush());
    }
}

module.exports = Command;

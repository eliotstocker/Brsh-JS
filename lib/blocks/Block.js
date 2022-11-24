'use strict';

const EventEmitter = require('events');
const Result = require('../Result');

class Block extends EventEmitter {
    constructor(input, context) {
        super();
        this.blockComplete = false;
        this.captureLines = true;
        this.input = [].concat(input);
        this.context = context;
        this.result = new Result();
        this.exitEarly = false;

        this.runBlock = this.runBlock.bind(this);
        this.onLine = this.onLine.bind(this);
        this.runScriptBlock = this.runScriptBlock.bind(this);
    }

    get captureInput() {
        return true;
    }

    static matchBlock(input) {
        return false;
    }

    static matchBlockEnd(input) {
        return false;
    }

    parseInput() {
        return Promise.reject("Command not implemented...");
    }

    run(block) {
        return Promise.reject("Command not implemented...");
    }

    runBlock() {
        let block;
        this.parsePromise = new Promise(parseComplete => {
            block = this.parseInput().then(block => {
                if(this.exitEarly) {
                    parseComplete();
                    delete this.parsePromise;
                    return;
                }

                if(this.blockComplete) {
                    return this.run(block)
                        .then(parseComplete)
                        .then(() => this.result)
                        .catch(e => {
                            this.stdErr = e;
                            return this.result;
                        })
                }

                parseComplete();
                delete this.parsePromise;

                return new Promise(resolve => {
                    this._onComplete = resolve;
                })
            });
        });

        return block;
    }

    runScriptBlock(lines) {
        if (!this.subShell) {
            this.subShell = new global.shell({cwd: this.context.cwd, filesystem: this.context.fs.getRaw()});
            this.subShell.context.source(this.context);

            this.subShell.on('stdOut', data => {
                this.stdOut = data;
                this.flush();
            });
            this.subShell.on('stdErr', data => {
                this.stdErr = data;
                this.flush();
            });
            this.subShell.on('exit', code => {
                this.context.destroy(code);
                this.exitCode = code;
            });
        }

        return lines.reduce((chain, line) => {
            return chain.then(() => this.subShell.onCommand(line)
                .then(() => {
                    if (this.subShell.destroyed) {
                        return Promise.reject();
                    }
                    if (this.subShell.lastCode !== 0) {
                        this.exitCode = this.subShell.lastCode;
                        return Promise.reject();
                    }
                }));
            }, Promise.resolve())
            .then(() => {
                this.context.source(this.subShell.context);
                return this.result;
            }).catch(() => {
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

    onLine(line) {
        this.input = [...this.input, line];

        this.parsePromise = new Promise(parseComplete => {
            this.parseInput().then(block => {
                if(this.exitEarly) {
                    parseComplete();
                    delete this.parsePromise;
                    return this._onComplete(block);
                }
                if(this.blockComplete) {
                    return this.run(block)
                        .then(parseComplete)
                        .then(() => this._onComplete(this.result))
                        .catch(e => {
                            this.stdErr = e;
                            this._onComplete(this.result);
                        });
                }

                parseComplete();
                delete this.parsePromise;
            });
        });

        return this.parsePromise;
    }

    flush() {
        this.emit('flush', this.result.flush());
    }

    onInput(key) {
        if (this.subShell && this.subShell.runningCommand && this.subShell.runningCommand.onInput && this.subShell.runningCommand.captureInput) {
            return this.subShell.runningCommand.onInput(key);
        }
        return false;
    }
}

module.exports = Block;
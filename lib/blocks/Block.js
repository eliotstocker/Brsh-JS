const Result = require('../Result');

class Block {
    constructor(input, context) {
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
        this.parsePromise = new Promise(paseComplete => {
            block = this.parseInput().then(block => {

                if(this.exitEarly) {
                    paseComplete();
                    delete this.parsePromise;
                    return;
                }

                if(this.blockComplete) {
                    return this.run(block)
                        .then(paseComplete)
                        .then(() => this.result);
                }

                paseComplete();
                delete this.parsePromise;

                return new Promise(resolve => {
                    this._onComplete = resolve;
                })
            });
        });

        return block;
    }

    runScriptBlock(lines) {
        this.subShell = new global.shell({cwd: this.context.cwd, filesystem: this.context.fs.getRaw()});
        this.subShell.context.source(this.context);

        this.subShell.on('stdOut', data => this.stdOut = data);
        this.subShell.on('stdErr', data => this.stdErr = data);

        return lines.reduce((chain, line) => {
            return chain.then(this.subShell.onCommand(line)
                .then(() => {
                    if (this.subShell.lastCode !== 0) {
                        this.exitCode = this.subShell.lastCode;
                        return Promise.reject();
                    }
                }));
            }, Promise.resolve())
        .then(() => {
            this.context.source(this.subShell.context);
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

        this.parsePromise = new Promise(paseComplete => {
            this.parseInput().then(block => {
                if(this.exitEarly) {
                    paseComplete();
                    delete this.parsePromise;
                    return this._onComplete(block);
                }
                if(this.blockComplete) {
                    return this.run(block)
                        .then(paseComplete)
                        .then(() => this._onComplete(this.result))
                }

                paseComplete();
                delete this.parsePromise;
            });
        });

        return this.parsePromise;
    }
}

module.exports = Block;
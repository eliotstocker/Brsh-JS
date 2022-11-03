'use strict';

const LocalCommand = require('./LocalCommand');
const commandLineArgs = require('command-line-args');

class Read extends LocalCommand {
    get requiresFilesystem() {
        return false;
    }

    get captureInput() {
        return true;
    }

    run() {
        let options;
        try {
            options = this.parseArgs();
        } catch(e) {
            this.printHelp(e);
            return Promise.reject();
        }

        if(options.help) {
            this.printHelp();
            return Promise.resolve();
        }

        this.nchars = options.nchars;
        this.var = options.name;

        this.stdErr = options.prompt || "";
        this.flush();

        return new Promise((resolve) => {
            const tid = setTimeout(() => {
                resolve();
                this.exitCode = 1;
            }, options.timeout ? options.timeout * 1000 : 86400000);

            this.completionCallback = (data) => {
                clearTimeout(tid);
                resolve(data);
            }
        });
    }

    onInput(key) {
        if(!this.inputBuffer) {
            this.inputBuffer = ""
        }

        if (key.length === 1) {
            this.inputBuffer += key;
        }

        if(this.inputBuffer.length === this.nchars) {
            if(this.var) {
                this.context.setVar(this.var, this.inputBuffer)
                this.completionCallback();
                return;
            }
            this.completionCallback(this.inputBuffer);
        }
    }

    printHelp(e) {
        if(e) {
            this.stdOut = e.message;
        }
        this.stdOut = 'usage: read [-n nchars] [-p prompt] [-t timeout] [name ...]'
    }

    parseArgs() {
        return commandLineArgs([
            {
                name: 'prompt',
                alias: 'p',
                type: String
            },
            {
                name: 'nchars',
                alias: 'n',
                type: Number
            },
            {
                name: 'timeout',
                alias: 't',
                type: Number
            },
            {
                name: 'help',
                alias: 'h',
                type: Boolean
            },
            {
                defaultOption: true,
                name: 'name',
                type: String
            },
        ], {argv: this.arguments});
    }
}

module.exports = Read;
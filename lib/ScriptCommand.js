'use strict';

const LocalCommand = require('./local/LocalCommand');

class ScriptCommand extends LocalCommand {
    constructor(script, args, context, source = false) {
        super(args, context);
        this.script = script;
        this.source = source;
    }

    get captureInput() {
        return true;
    }

    run() {
        this.sandbox = new global.shell({cwd: this.context.cwd, filesystem: this.context.fs.getRaw()});
        this.sandbox.context.source(this.context);

        this.sandbox.on('stdOut', data => {
            this.stdOut = data;
            this.flush();
        });
        this.sandbox.on('stdErr', data => {
            this.stdErr = data;
            this.flush();
        });

        const lines = this.script.split(/\r?\n/);

        //check script has interpreter
        if(!lines[0].startsWith('#!')) {
            return Promise.reject('no interpreter set');
        }

        return lines.reduce((chain, line) => {
            return chain.then(() => this.sandbox.onCommand(line)
                .then(() => {
                    if (this.sandbox.lastCode !== 0) {
                        this.exitCode = this.sandbox.lastCode;
                        return Promise.reject();
                    }
                }));
        }, Promise.resolve())
            .then(() => {
                if(this.source) {
                    this.context.source(this.sandbox.context);
                }
            });
    }

    onInput(key) {
        if(this.sandbox.runningCommand.captureInput) {
            this.sandbox.runningCommand.onInput(key);
        }
    }
}

module.exports = ScriptCommand;
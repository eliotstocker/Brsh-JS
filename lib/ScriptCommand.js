'use strict';

const LocalCommand = require('./local/LocalCommand');

class ScriptCommand extends LocalCommand {
    constructor(script, args, context, source = false) {
        super(args, context);
        this.script = script;
        this.source = source;
    }

    run() {
        this.sandbox = new global.shell({cwd: this.context.cwd, filesystem: this.context.fs.getRaw()});
        this.sandbox.context.source(this.context);

        this.sandbox.on('stdOut', data => this.stdOut = data);
        this.sandbox.on('stdErr', data => this.stdErr = data);

        const lines = this.script.split(/\r?\n/);

        //check script has interpreter
        if(!lines[0].startsWith('#!')) {
            return Promise.reject('no interpreter set');
        }

        return lines.reduce((chain, line) => {
            return chain.then(this.sandbox.onCommand(line)
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
}

module.exports = ScriptCommand;
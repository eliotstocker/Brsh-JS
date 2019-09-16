'use strict';

const LocalCommand = require('./local/LocalCommand');

class ScriptCommand extends LocalCommand {
    constructor(script, args, context, source = false) {
        super(args, context);
        this.script = script;
        this.source = source;
    }

    run() {
        this.sandbox = new global.shell({path: this.context.getVar('PATH'), cwd: this.context.cwd, filesystem: this.context.fs.getRaw()});

        this.sandbox.on('stdOut', data => this.stdOut = data);
        this.sandbox.on('stdErr', data => this.stdErr = data);

        const lines = this.script.split(/\r?\n/);

        //check script has interpreter
        if(!lines[0].startsWith('#!')) {
            return Promise.reject('no interpreter set');
        }

        //remove interpreter
        lines.shift();

        return lines.reduce((chain, line) => {
            const commentParts = line.split('#');
            const cmdLine = commentParts[0].trim();

            if(cmdLine.length > 0) {
                return chain.then(this.sandbox.onCommand(cmdLine)
                    .then(() => {
                        if (this.sandbox.lastCode !== 0) {
                            this.exitCode = this.sandbox.lastCode;
                            return Promise.reject();
                        }
                    }));
            }
            return chain;
        }, Promise.resolve())
            .then(() => {
                if(this.source) {
                    this.context.source(this.sandbox.context);
                }
            });
    }
}

module.exports = ScriptCommand;
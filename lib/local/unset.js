'use strict';

const LocalCommand = require('./LocalCommand');

class Unset extends LocalCommand {
    static get name() { return 'unset'; }

    run() {
        const names = this.arguments.filter(arg => arg !== '-v');
        if(names.some(name => name.startsWith('-'))) {
            this.stdErr = `unset: ${names.find(name => name.startsWith('-'))}: only -v is supported`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        names.forEach(name => {
            if(!/^[A-Za-z_]\w*$|^\d+$/.test(name)) {
                this.stdErr = `unset: '${name}': not a valid identifier`;
                this.exitCode = 1;
                return;
            }
            this.context.unsetVar(name);
        });
        return Promise.resolve();
    }
}

module.exports = Unset;

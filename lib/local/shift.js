'use strict';

const LocalCommand = require('./LocalCommand');

class Shift extends LocalCommand {
    static get name() { return 'shift'; }

    run() {
        const arg = this.arguments[0];
        const n = arg === undefined ? 1 : Number(arg);
        if(!Number.isInteger(n) || n < 0) {
            return this._fail(`shift: ${arg}: numeric argument required`);
        }

        const count = parseInt(this.context.getVar('#'), 10) || 0;
        if(n > count) {
            return this._fail('shift: shift count out of range');
        }

        const remaining = Array.from({length: count}, (_, i) => this.context.getVar(String(i + 1))).slice(n);
        for(let i = 1; i <= count; i++) {
            this.context.unsetVar(String(i));
        }
        remaining.forEach((val, i) => this.context.setVar(String(i + 1), val));
        this.context.setVar('#', String(remaining.length));
        this.context.setVar('@', remaining.join(' '));
        this.context.setVar('*', remaining.join(' '));
        return Promise.resolve();
    }

    _fail(message) {
        this.stdErr = message;
        this.exitCode = 1;
        return Promise.resolve();
    }
}

module.exports = Shift;

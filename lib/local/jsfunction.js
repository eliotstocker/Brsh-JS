'use strict';

const LocalCommand = require('./LocalCommand');
const Command = require('../Command');

class JsFunction extends LocalCommand {
    get name() { return 'jsfunction'; }

    run() {
        const [name, ...bodyParts] = this.arguments;
        if (!name || bodyParts.length === 0) {
            this.stdErr = 'usage: jsfunction <name> <function-body>';
            this.exitCode = 1;
            return Promise.resolve();
        }

        const body = bodyParts.join(' ');
        let fn;
        try {
            // eslint-disable-next-line no-new-func
            fn = new Function('return (' + body + ')')();
            if (typeof fn !== 'function') throw new Error('expression is not a function');
        } catch(e) {
            this.stdErr = `jsfunction: ${e.message}`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        class DynamicCommand extends Command {
            run() {
                let result;
                try {
                    result = fn(this.arguments);
                } catch(e) {
                    this.stdErr = e.message || String(e);
                    this.exitCode = 1;
                    return Promise.resolve();
                }
                if (result && typeof result.then === 'function') {
                    return result.then(v => {
                        if (v != null) this.stdOut = String(v);
                    }).catch(e => {
                        this.stdErr = e.message || String(e);
                        this.exitCode = 1;
                    });
                }
                if (result != null) this.stdOut = String(result);
                return Promise.resolve();
            }
        }
        Object.defineProperty(DynamicCommand, 'name', { value: name, configurable: true });

        this.context.setCommand(DynamicCommand);
        return Promise.resolve();
    }
}

module.exports = JsFunction;

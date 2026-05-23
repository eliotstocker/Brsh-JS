'use strict';

const LocalCommand = require('./LocalCommand');

// Mapping of -o option names to single-letter flags
const NAMED_FLAGS = {
    errexit:   'e',
    xtrace:    'x',
    nounset:   'u',
    noexec:    'n',
    allexport: 'a',
};

class Set extends LocalCommand {
    static get name() { return 'set'; }

    run() {
        const args = this.arguments;

        // `set` with no arguments: print all variables sorted
        if (args.length === 0) {
            const vars = this.context.vars;
            Object.keys(vars).sort().forEach(key => {
                this.stdOut = `${key}=${vars[key]}`;
            });
            return Promise.resolve();
        }

        let i = 0;
        while (i < args.length) {
            const arg = args[i];

            // `set -- [arg1 arg2 ...]`: replace positional parameters
            if (arg === '--') {
                const positional = args.slice(i + 1);
                // Clear existing positional params
                let n = 1;
                while (this.context.getVar(String(n))) {
                    this.context.unsetVar(String(n));
                    n++;
                }
                // Set new ones
                positional.forEach((val, idx) =>
                    this.context.setVar(String(idx + 1), val));
                this.context.setVar('#', String(positional.length));
                return Promise.resolve();
            }

            // Flag modifier: -xyz sets flags, +xyz clears flags
            if ((arg.startsWith('-') || arg.startsWith('+')) && arg.length > 1 && arg[1] !== '-') {
                const enabling = arg[0] === '-';
                const flagStr = arg.slice(1);

                // `set -o [option]` / `set +o [option]`
                if (flagStr === 'o') {
                    i++;
                    const optionName = args[i];
                    if (optionName === undefined) {
                        // `set -o` with no name: list all options
                        Object.entries(NAMED_FLAGS).forEach(([name, char]) => {
                            const current = this.context.getVar('-') || '';
                            this.stdOut = `${name.padEnd(15)} ${current.includes(char) ? 'on' : 'off'}`;
                        });
                        i++;
                        continue;
                    }
                    const flagChar = NAMED_FLAGS[optionName];
                    if (flagChar) {
                        this._setFlag(flagChar, enabling);
                    } else {
                        this.stdErr = `set: ${optionName}: invalid option name`;
                    }
                    i++;
                    continue;
                }

                for (const flag of flagStr) {
                    this._setFlag(flag, enabling);
                }
                i++;
                continue;
            }

            i++;
        }

        return Promise.resolve();
    }

    _setFlag(flag, enabled) {
        const current = this.context.getVar('-') || '';
        if (enabled) {
            if (!current.includes(flag)) {
                this.context.setVar('-', current + flag);
            }
        } else {
            this.context.setVar('-', current.split('').filter(c => c !== flag).join(''));
        }
    }
}

module.exports = Set;

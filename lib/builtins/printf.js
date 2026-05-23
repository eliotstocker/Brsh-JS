'use strict';

const Command = require('../Command');

class Printf extends Command {
    static get name() { return 'printf'; }

    run() {
        const args = [...this.arguments];
        if (!args.length) return Promise.resolve();

        let fmt = args.shift();

        // Process escape sequences in the format string
        fmt = fmt
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\r/g, '\r')
            .replace(/\\a/g, '\x07')
            .replace(/\\b/g, '\x08')
            .replace(/\\e/g, '\x1b')
            .replace(/\\f/g, '\x0c')
            .replace(/\\v/g, '\x0b')
            .replace(/\\\\/g, '\\');

        // Process format specifiers
        let result = '';
        let argIdx = 0;
        for (let i = 0; i < fmt.length; i++) {
            if (fmt[i] === '%' && i + 1 < fmt.length) {
                const spec = fmt[i + 1];
                if (spec === 's') { result += String(args[argIdx++] ?? ''); i++; }
                else if (spec === 'd' || spec === 'i') { result += String(parseInt(args[argIdx++]) || 0); i++; }
                else if (spec === 'f') { result += String(parseFloat(args[argIdx++]) || 0); i++; }
                else if (spec === '%') { result += '%'; i++; }
                else { result += fmt[i]; }
            } else {
                result += fmt[i];
            }
        }

        // Emit each line directly — no automatic trailing newline (unlike echo)
        result.split(/\r?\n/).forEach(line => this.stdOut = line);
        return Promise.resolve();
    }
}

module.exports = Printf;

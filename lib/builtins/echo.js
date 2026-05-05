'use strict';

const Command = require('../Command');

class Echo extends Command {
    run() {
        const args = [...this.arguments];
        let noNewline = false;
        let interpretEscapes = false;

        // Parse leading flags: -n, -e, -E, -ne, -en, etc.
        while (args.length > 0 && /^-[neE]+$/.test(args[0])) {
            const flag = args.shift();
            if (flag.includes('n')) noNewline = true;
            if (flag.includes('e')) interpretEscapes = true;
            if (flag === '-E') interpretEscapes = false;
        }

        let output = args.join(' ');

        if (interpretEscapes) {
            output = output
                .replace(/\\c.*$/s, () => { noNewline = true; return ''; })
                .replace(/\\0([0-7]{1,3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)))
                .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\r/g, '\r')
                .replace(/\\a/g, '\x07')
                .replace(/\\b/g, '\x08')
                .replace(/\\e/g, '\x1b')
                .replace(/\\f/g, '\x0c')
                .replace(/\\v/g, '\x0b')
                .replace(/\\\\/g, '\\');
        }

        if (noNewline) {
            // Emit directly so runCommand doesn't add an extra blank line
            output.split(/\r?\n/).forEach(line => this.stdOut = line);
            return Promise.resolve();
        }

        return Promise.resolve(output);
    }
}

module.exports = Echo;

'use strict';

const Command = require('../Command');
const {readInput, toLines} = require('./readInput');

class Tail extends Command {
    static get name() { return 'tail'; }

    get requiresFilesystem() {
        return true;
    }

    run() {
        let count = '10';
        let bytes = false;
        const paths = [];

        const args = this.arguments;
        for(let i = 0; i < args.length; i++) {
            const arg = args[i];
            if(arg === '-n' || arg === '-c') {
                bytes = arg === '-c';
                count = args[++i];
            } else if(/^-[nc]./.test(arg)) {
                bytes = arg[1] === 'c';
                count = arg.slice(2);
            } else if(/^-\d+$/.test(arg) || /^\+\d+$/.test(arg)) {
                //legacy -N and +N
                count = arg;
            } else if(arg === '-f' || arg === '-q') {
                continue;
            } else if(arg.startsWith('-') && arg.length > 1) {
                this.stdErr = `tail: invalid option -- ${arg.slice(1)}`;
                this.exitCode = 1;
                return Promise.resolve();
            } else {
                paths.push(arg);
            }
        }

        if(!/^[+-]?\d+$/.test(count || '')) {
            this.stdErr = `tail: invalid number: ${count}`;
            this.exitCode = 1;
            return Promise.resolve();
        }
        const fromStart = count.startsWith('+');
        const n = Math.abs(parseInt(count, 10));

        const sources = paths.length > 0 ? paths : [undefined];
        sources.forEach((path, i) => {
            const text = readInput(this, path, 'tail');
            if(text === null) {
                return;
            }

            if(sources.length > 1) {
                i > 0 && (this.stdOut = '');
                this.stdOut = `==> ${path === undefined ? 'standard input' : path} <==`;
            }

            if(bytes) {
                const out = fromStart ? text.slice(Math.max(n - 1, 0)) : (n < 1 ? '' : text.slice(-n));
                toLines(out).forEach(line => this.stdOut = line);
                return;
            }

            const lines = toLines(text);
            const out = fromStart ? lines.slice(Math.max(n - 1, 0)) : (n < 1 ? [] : lines.slice(-n));
            out.forEach(line => this.stdOut = line);
        });

        return Promise.resolve();
    }
}

module.exports = Tail;

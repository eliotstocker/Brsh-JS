'use strict';

const LocalCommand = require('./LocalCommand');
const commandLineArgs = require('command-line-args');

class Read extends LocalCommand {
    static get name() { return 'read'; }

    get requiresFilesystem() {
        return false;
    }

    get captureInput() {
        return true;
    }

    run() {
        let options;
        try {
            options = this.parseArgs();
        } catch(e) {
            this.printHelp(e);
            return Promise.reject();
        }

        if(options.help) {
            this.printHelp();
            return Promise.resolve();
        }

        this.nchars = options.nchars;
        this.names = options.name || [];
        this.raw = options.raw;

        return new Promise((resolve) => {
            const tid = setTimeout(() => {
                resolve();
                this.exitCode = 1;
            }, options.timeout ? options.timeout * 1000 : 86400000);

            this.completionCallback = (data) => {
                clearTimeout(tid);
                resolve(data);
            };

            // Flush prompt after completionCallback is set so that any
            // synchronous onInput triggered by the prompt can complete it.
            this.stdErr = options.prompt || "";
            this.flush();
        });
    }

    onInput(key) {
        if(!this.inputBuffer) {
            this.inputBuffer = ""
        }

        //without -r a backslash escapes the next char, and backslash-newline continues the line
        if(!this.raw && !this.escaped && key === '\\') {
            this.escaped = true;
            return;
        }

        if(this.escaped) {
            delete this.escaped;
            if(key === 'Enter') {
                return;
            }
        }

        if (key.length === 1) {
            this.inputBuffer += key;
            if(this.inputBuffer.length !== this.nchars) {
                return;
            }
        }

        if(key === 'Enter' || this.inputBuffer.length === this.nchars) {
            this._finish();
        }
    }

    _finish() {
        if(this.names.length < 1) {
            return this.completionCallback(this.inputBuffer);
        }

        //getVar returns '' for unset, but an empty IFS is meaningful
        const ifs = this.context.vars.IFS;
        this._split(this.inputBuffer, ifs === undefined ? ' \t\n' : ifs)
            .forEach((value, i) => this.context.setVar(this.names[i], value));
        this.completionCallback();
    }

    //one value per name, the last one takes the remainder
    _split(line, ifs) {
        const {names} = this;
        const esc = s => s.replace(/[\]\\^-]/g, '\\$&');
        const ws = esc(ifs.replace(/[^ \t\n]/g, ''));
        const other = esc(ifs.replace(/[ \t\n]/g, ''));
        const trimStart = s => ws ? s.replace(new RegExp(`^[${ws}]+`), '') : s;
        const trimEnd = s => ws ? s.replace(new RegExp(`[${ws}]+$`), '') : s;
        const delim = ifs === '' ? null : new RegExp(other ? `[${ws}]*[${other}][${ws}]*|[${ws}]+` : `[${ws}]+`);

        let rest = trimStart(line);
        return names.map((_, i) => {
            if(i === names.length -1) {
                return trimEnd(rest);
            }
            const m = delim && delim.exec(rest);
            if(!m) {
                const field = rest;
                rest = '';
                return field;
            }
            const field = rest.slice(0, m.index);
            rest = rest.slice(m.index + m[0].length);
            return field;
        });
    }

    printHelp(e) {
        if(e) {
            this.stdOut = e.message;
        }
        this.stdOut = 'usage: read [-r] [-n nchars] [-p prompt] [-t timeout] [name ...]'
    }

    parseArgs() {
        return commandLineArgs([
            {
                name: 'prompt',
                alias: 'p',
                type: String
            },
            {
                name: 'nchars',
                alias: 'n',
                type: Number
            },
            {
                name: 'timeout',
                alias: 't',
                type: Number
            },
            {
                name: 'raw',
                alias: 'r',
                type: Boolean
            },
            {
                name: 'help',
                alias: 'h',
                type: Boolean
            },
            {
                defaultOption: true,
                multiple: true,
                name: 'name',
                type: String
            },
        ], {argv: this.arguments});
    }
}

module.exports = Read;
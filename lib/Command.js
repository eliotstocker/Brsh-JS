'use strict';

const events = require('events');
const Result = require('./Result');
const { TtyStream, parseVtKeys } = require('./TtyStream');

const EventEmitter = events.EventEmitter || events.default || events;

class Command extends EventEmitter {
    constructor(args, context) {
        super();
        this.arguments = args;
        this.result = new Result();
        this.context = context || null;

        const cols = (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('COLUMNS'), 10)) || 80;
        const rows = (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('LINES'), 10)) || 24;

        this.stdinStream = new TtyStream({ columns: cols, rows: rows });
        this.stdin = this.stdinStream;
        this.stdout = new TtyStream({
            columns: cols,
            rows: rows,
            onWrite: (chunk) => this.emit('stdout', chunk)
        });
        this.stderr = new TtyStream({
            columns: cols,
            rows: rows,
            onWrite: (chunk) => this.emit('stderr', chunk)
        });

        this._onStdinStreamData = (chunk) => {
            if (!this.captureInput) return;
            const keys = parseVtKeys(chunk);
            for (const k of keys) {
                if (!this.interactive && !this.stdinStream.isRaw) {
                    if (k === 'Enter') this.stdout.write('\r\n');
                    else if (k === 'Backspace') this.stdout.write('\b \b');
                    else if (k.length === 1) this.stdout.write(k);
                }
                this.onInput(k);
            }
        };
        this.stdinStream.on('data', this._onStdinStreamData);
    }

    get name() {
        return 'unnamed';
    }

    run() {
        return Promise.reject("Command not implemented...");
    }

    runCommand() {
        return Promise.resolve()
            .then(() => this.run())
            .then(d => {
                if(d) {
                    d.split(/\r?\n/).forEach(line => this.stdOut = line);
                }
                return this.result;
            })
            .catch(e => {
                // Re-throw shell control-flow signals (break, continue, return,
                // errexit) so they propagate correctly through function calls
                // and nested script execution.
                if (e && e.__type) {
                    throw e;
                }
                if(e) {
                    this.stdErr = e.message || e;
                }
                this.exitCode = 127;
                return this.result;
            });
    }

    onInput(char) {
        //ignored by default, can be overridden in a command if needed to get input
    }

    set exitCode(code) {
        this.result.exitCode = code;
    }

    set stdOut(String) {
        this.result.addStdOutLine(String);
    }

    set stdErr(String) {
        this.result.addStdErrLine(String);
    }

    flush() {
        this.emit('flush', this.result.flush());
    }
}

module.exports = Command;

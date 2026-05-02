'use strict';

const Command = require('../Command');

class Test extends Command {
    get name() { return 'test'; }
    get requiresFilesystem() { return true; }

    run() {
        const args = [...this.arguments];
        if (args[args.length - 1] === ']') args.pop();

        if (!this._evaluate(args)) this.exitCode = 1;
        return Promise.resolve();
    }

    _evaluate(args) {
        if (args.length === 0) return false;

        if (args[0] === '!') return !this._evaluate(args.slice(1));

        if (args.length === 1) return args[0].length > 0;

        if (args.length === 2) {
            const [op, val] = args;
            switch (op) {
                case '-n': return val.length > 0;
                case '-z': return val.length === 0;
                case '-f': {
                    if (!this.fs) return false;
                    const e = this.fs.getFileByPath(val);
                    return e !== null && e !== undefined && e.constructor !== Object;
                }
                case '-d': {
                    if (!this.fs) return false;
                    const e = this.fs.getFileByPath(val);
                    return e !== null && e !== undefined && e.constructor === Object;
                }
                default: return false;
            }
        }

        if (args.length === 3) {
            const [a, op, b] = args;
            switch (op) {
                case '=': case '==': return a === b;
                case '!=': return a !== b;
                case '-eq': return parseInt(a) === parseInt(b);
                case '-ne': return parseInt(a) !== parseInt(b);
                case '-lt': return parseInt(a) < parseInt(b);
                case '-le': return parseInt(a) <= parseInt(b);
                case '-gt': return parseInt(a) > parseInt(b);
                case '-ge': return parseInt(a) >= parseInt(b);
                default: return false;
            }
        }

        return false;
    }
}

class TestBracket extends Test {
    get name() { return '['; }
}
// Override the class name so Context.setCommand stores it under '[' not 'testbracket'
Object.defineProperty(TestBracket, 'name', { value: '[' });

module.exports = { Test, TestBracket };

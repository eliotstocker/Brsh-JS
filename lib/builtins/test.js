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

        // -o (OR) has lower precedence than -a (AND)
        const orIdx = args.indexOf('-o');
        if (orIdx !== -1) {
            return this._evaluate(args.slice(0, orIdx)) || this._evaluate(args.slice(orIdx + 1));
        }

        const andIdx = args.indexOf('-a');
        if (andIdx !== -1) {
            return this._evaluate(args.slice(0, andIdx)) && this._evaluate(args.slice(andIdx + 1));
        }

        if (args[0] === '!') return !this._evaluate(args.slice(1));

        if (args.length === 1) return args[0].length > 0;

        if (args.length === 2) {
            const [op, val] = args;
            switch (op) {
                case '-n': return val.length > 0;
                case '-z': return val.length === 0;
                case '-e': {
                    if (!this.fs) return false;
                    const e = this.fs.getFileByPath(val);
                    return e !== null && e !== undefined;
                }
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
                case '-r': {
                    if (!this.fs) return false;
                    const m = this.fs.getMode(val);
                    return m !== null && (m & 0o444) !== 0;
                }
                case '-w': {
                    if (!this.fs) return false;
                    const m = this.fs.getMode(val);
                    return m !== null && (m & 0o222) !== 0;
                }
                case '-x': {
                    if (!this.fs) return false;
                    const m = this.fs.getMode(val);
                    return m !== null && (m & 0o111) !== 0;
                }
                case '-s': {
                    if (!this.fs) return false;
                    const e = this.fs.getFileByPath(val);
                    if (e === null || e === undefined || e.constructor === Object) return false;
                    return e.toString().length > 0;
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

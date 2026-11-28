'use strict';

const Command = require('../Command');
const {readInput, toLines} = require('./readInput');

const posixClasses = {
    alpha: 'a-zA-Z',
    digit: '0-9',
    alnum: 'a-zA-Z0-9',
    upper: 'A-Z',
    lower: 'a-z',
    space: '\\s',
    blank: ' \\t',
    punct: '!-\\/:-@\\[-`{-~',
    xdigit: '0-9A-Fa-f'
};

//turn a posix BRE (or ERE when ere is set) into a js regex source
function convertRegex(src, ere) {
    let out = '';
    for(let i = 0; i < src.length; i++) {
        const ch = src[i];
        if(ch === '[') {
            //copy the bracket expression, js needs backslashes escaped and has no [:class:]
            let j = i + 1;
            let set = '[';
            if(src[j] === '^') {
                set += '^';
                j++;
            }
            if(src[j] === ']') {
                set += '\\]';
                j++;
            }
            for(; j < src.length && src[j] !== ']'; j++) {
                const cls = /^\[:(\w+):\]/.exec(src.slice(j));
                if(cls && posixClasses[cls[1]]) {
                    set += posixClasses[cls[1]];
                    j += cls[0].length -1;
                } else {
                    set += src[j] === '\\' ? '\\\\' : src[j];
                }
            }
            if(j >= src.length) {
                throw new Error('unterminated address regex');
            }
            out += `${set}]`;
            i = j;
        } else if(ch === '\\' && i + 1 < src.length) {
            const next = src[++i];
            //in a BRE these escapes are the special operators
            out += !ere && '(){}+?|'.includes(next) ? next : `\\${next}`;
        } else if(!ere && '(){}+?|'.includes(ch)) {
            out += `\\${ch}`;
        } else if(!ere && ch === '*' && (out === '' || out.endsWith('('))) {
            out += '\\*';
        } else {
            out += ch;
        }
    }
    return out;
}

//reads up to an unescaped delimiter, returns [text, indexAfterDelimiter]
function readUntil(script, i, delim) {
    let text = '';
    for(; i < script.length; i++) {
        if(script[i] === '\\' && i + 1 < script.length) {
            //an escaped delimiter is just the delimiter, anything else is kept for later
            text += script[i + 1] === delim ? delim : `\\${script[i + 1]}`;
            i++;
        } else if(script[i] === delim) {
            return [text, i + 1];
        } else {
            text += script[i];
        }
    }
    throw new Error('unterminated command');
}

function parseReplacement(text) {
    const parts = [];
    let lit = '';
    for(let i = 0; i < text.length; i++) {
        if(text[i] === '\\' && i + 1 < text.length) {
            const next = text[++i];
            if(/\d/.test(next)) {
                lit && parts.push(lit);
                lit = '';
                parts.push(parseInt(next, 10));
            } else {
                lit += next === 'n' ? '\n' : next === 't' ? '\t' : next;
            }
        } else if(text[i] === '&') {
            lit && parts.push(lit);
            lit = '';
            parts.push(0);
        } else {
            lit += text[i];
        }
    }
    lit && parts.push(lit);
    return parts;
}

class Sed extends Command {
    static get name() { return 'sed'; }

    get requiresFilesystem() {
        return true;
    }

    run() {
        let quiet = false;
        let ere = false;
        const scripts = [];
        const paths = [];

        const args = this.arguments;
        for(let i = 0; i < args.length; i++) {
            const arg = args[i];
            if(arg === '--') {
                paths.push(...args.slice(i + 1));
                break;
            }
            if(arg.length < 2 || !arg.startsWith('-')) {
                paths.push(arg);
                continue;
            }
            for(let j = 1; j < arg.length; j++) {
                const flag = arg[j];
                if(flag === 'n') {
                    quiet = true;
                } else if(flag === 'E' || flag === 'r') {
                    ere = true;
                } else if(flag === 'e') {
                    //script is the rest of this arg, or the next one
                    scripts.push(j + 1 < arg.length ? arg.slice(j + 1) : args[++i]);
                    break;
                } else {
                    return this._fail(`invalid option -- ${flag}`);
                }
            }
        }

        //without -e the first operand is the script
        scripts.length < 1 && paths.length > 0 && scripts.push(paths.shift());
        if(scripts.length < 1 || scripts.some(s => s === undefined)) {
            return this._fail('usage: sed [-nEr] [-e script] script [file ...]');
        }

        let cmds;
        try {
            this.lastRe = null;
            cmds = this._parse(scripts.join('\n'), ere);
        } catch(e) {
            return this._fail(e.message);
        }

        const texts = (paths.length > 0 ? paths : [undefined]).map(p => readInput(this, p, 'sed'));
        //an unreadable file already reported itself, carry on with the rest like sed does
        const lines = texts.filter(t => t !== null).flatMap(toLines);

        this._execute(cmds, lines, quiet);
        return Promise.resolve();
    }

    _fail(message) {
        this.stdErr = message.startsWith('usage') ? message : `sed: ${message}`;
        this.exitCode = 1;
        return Promise.resolve();
    }

    _regex(src, ere, flags) {
        //an empty regex means the last one used
        if(src === '') {
            if(!this.lastRe) {
                throw new Error('no previous regular expression');
            }
            return new RegExp(this.lastRe.source, flags);
        }
        const re = new RegExp(convertRegex(src, ere), flags);
        this.lastRe = re;
        return re;
    }

    _parse(script, ere) {
        const cmds = [];
        let i = 0;

        const skip = chars => {
            while(i < script.length && chars.includes(script[i])) {
                i++;
            }
        };
        const address = () => {
            if(/\d/.test(script[i] || '')) {
                const start = i;
                skip('0123456789');
                return {type: 'line', n: parseInt(script.slice(start, i), 10)};
            }
            if(script[i] === '$') {
                i++;
                return {type: 'last'};
            }
            if(script[i] === '/') {
                const [src, next] = readUntil(script, i + 1, '/');
                i = next;
                return {type: 're', re: this._regex(src, ere, '')};
            }
        };

        for(skip(' \t\n;'); i < script.length; skip(' \t\n;')) {
            const cmd = {};
            cmd.a1 = address();
            if(cmd.a1 && script[i] === ',') {
                i++;
                cmd.a2 = address();
                if(!cmd.a2) {
                    throw new Error('unexpected `,\'');
                }
            }
            skip(' \t');
            if(script[i] === '!') {
                cmd.negate = true;
                i++;
                skip(' \t');
            }

            cmd.name = script[i++];
            if(cmd.name === 's') {
                const delim = script[i++];
                if(!delim || delim === '\n' || delim === '\\') {
                    throw new Error('unterminated `s\' command');
                }
                const [pattern, afterPattern] = readUntil(script, i, delim);
                const [replacement, afterReplacement] = readUntil(script, afterPattern, delim);
                i = afterReplacement;

                cmd.global = false;
                cmd.print = false;
                cmd.nth = 1;
                let flags = 'g';
                for(; i < script.length && /[gpiI\d]/.test(script[i]); i++) {
                    const f = script[i];
                    if(f === 'g') {
                        cmd.global = true;
                    } else if(f === 'p') {
                        cmd.print = true;
                    } else if(f === 'i' || f === 'I') {
                        flags += 'i';
                    } else {
                        cmd.nth = parseInt(f, 10) || 1;
                    }
                }
                cmd.re = this._regex(pattern, ere, flags);
                cmd.replacement = parseReplacement(replacement);
            } else if(cmd.name === 'y') {
                const delim = script[i++];
                const [from, afterFrom] = readUntil(script, i, delim);
                const [to, afterTo] = readUntil(script, afterFrom, delim);
                i = afterTo;
                if(from.length !== to.length) {
                    throw new Error('strings for `y\' command are different lengths');
                }
                cmd.map = Object.fromEntries([...from].map((c, idx) => [c, to[idx]]));
            } else if(!'dpq='.includes(cmd.name || '?')) {
                throw new Error(`unknown command: \`${cmd.name || ''}'`);
            }

            skip(' \t');
            if(i < script.length && !';\n'.includes(script[i])) {
                throw new Error('extra characters after command');
            }
            cmds.push(cmd);
        }
        return cmds;
    }

    _matches(a, ln, line, last) {
        return a.type === 'line' ? ln === a.n
            : a.type === 'last' ? ln === last
            : a.re.test(line);
    }

    _selected(cmd, ln, line, last) {
        if(!cmd.a1) {
            return true;
        }
        if(!cmd.a2) {
            return this._matches(cmd.a1, ln, line, last);
        }
        if(cmd.active) {
            const ends = cmd.a2.type === 'line' ? ln >= cmd.a2.n : this._matches(cmd.a2, ln, line, last);
            ends && delete cmd.active;
            return true;
        }
        if(!this._matches(cmd.a1, ln, line, last)) {
            return false;
        }
        //a regex end address is only checked from the next line, a line number may already be behind us
        if(!(cmd.a2.type === 'line' && cmd.a2.n <= ln)) {
            cmd.active = true;
        }
        return true;
    }

    _substitute(cmd, line) {
        let count = 0;
        let replaced = false;
        const out = line.replace(cmd.re, (...m) => {
            count++;
            if(count < cmd.nth || (!cmd.global && count > cmd.nth)) {
                return m[0];
            }
            replaced = true;
            const groups = m.slice(0, -2);
            return cmd.replacement.map(p => typeof p === 'number' ? (groups[p] || '') : p).join('');
        });
        return {out, replaced};
    }

    _execute(cmds, lines, quiet) {
        for(let idx = 0; idx < lines.length; idx++) {
            const ln = idx + 1;
            let line = lines[idx];
            let deleted = false;
            let quit = false;

            for(const cmd of cmds) {
                if(this._selected(cmd, ln, line, lines.length) === !!cmd.negate) {
                    continue;
                }
                if(cmd.name === 's') {
                    const {out, replaced} = this._substitute(cmd, line);
                    line = out;
                    replaced && cmd.print && (this.stdOut = line);
                } else if(cmd.name === 'y') {
                    line = [...line].map(c => cmd.map[c] ?? c).join('');
                } else if(cmd.name === 'p') {
                    this.stdOut = line;
                } else if(cmd.name === '=') {
                    this.stdOut = String(ln);
                } else if(cmd.name === 'd') {
                    deleted = true;
                    break;
                } else if(cmd.name === 'q') {
                    quit = true;
                    break;
                }
            }

            !quiet && !deleted && (this.stdOut = line);
            if(quit) {
                return;
            }
        }
    }
}

module.exports = Sed;

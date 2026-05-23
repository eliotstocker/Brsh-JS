'use strict';

const LocalCommand = require('./local/LocalCommand');

/**
 * Returns true if the first line of a file is a shebang for a known/supported
 * interpreter: #!/sh.js (legacy), #!/bin/sh, or #!/bin/brsh.
 */
function isKnownInterpreter(firstLine) {
    return /^#!\/(sh\.js|bin\/(sh|brsh))/.test(firstLine);
}

class ScriptCommand extends LocalCommand {
    constructor(script, args, context, source = false) {
        super(args, context);
        this.script = script;
        this.source = source;
    }

    // Only capture input when the sandbox itself has a command waiting for it
    // (e.g. an active `read`). This prevents swallowing keystrokes during
    // normal command execution.
    get captureInput() {
        return !!(this.sandbox
            && this.sandbox.runningCommand
            && this.sandbox.runningCommand.captureInput);
    }

    onInput(char) {
        if (this.sandbox) {
            this.sandbox.onInput(char);
        }
    }

    run() {
        const fsOpts = this.context.fs.isRealFilesystem
            ? { useRealFilesystem: true }
            : { filesystem: this.context.fs.getRaw(), permissions: this.context.fs.getRawPermissions() };
        this.sandbox = new global.shell({
            cwd: this.context.fs.cwd,
            ...fsOpts
        });
        this.sandbox.context.source(this.context);

        this.sandbox.on('stdOut', data => { this.stdOut = data; this.flush(); });
        this.sandbox.on('stdErr', data => { this.stdErr = data; this.flush(); });

        this._scriptFunctions = {};

        const lines = this.script.split(/\r?\n/);

        if (!isKnownInterpreter(lines[0])) {
            const interpreter = lines[0].startsWith('#!')
                ? lines[0].slice(2).split(/\s/)[0]
                : lines[0];
            return Promise.reject(`${interpreter}: bad interpreter: No such file or directory`);
        }

        const nodes = this._parseLines(lines.slice(1));
        return this._executeNodes(nodes)
            .catch(e => {
                if (e && e.__type === 'return') {
                    this.sandbox.lastCode = e.code;
                } else {
                    return Promise.reject(e);
                }
            })
            .then(() => {
                this.exitCode = this.sandbox.lastCode;
                if(this.source) {
                    this.context.source(this.sandbox.context);
                }
            });
    }

    _parseLines(lines) {
        const nodes = [];
        let i = 0;
        while (i < lines.length) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#')) { i++; continue; }

            if (line.startsWith('if ') || line === 'if') {
                const result = this._parseIf(lines, i);
                nodes.push(result.node);
                i += result.consumed;
                continue;
            }
            if (line.startsWith('while ')) {
                const result = this._parseWhile(lines, i);
                nodes.push(result.node);
                i += result.consumed;
                continue;
            }
            if (line.startsWith('for ')) {
                const result = this._parseFor(lines, i);
                nodes.push(result.node);
                i += result.consumed;
                continue;
            }
            if (line.startsWith('case ') || line === 'case') {
                const result = this._parseCase(lines, i);
                nodes.push(result.node);
                i += result.consumed;
                continue;
            }
            if (/^(?:function\s+[\w\d_]+|[\w\d_]+\s*\(\s*\))\s*(?:\{.*)?$/.test(line)) {
                const result = this._parseFunction(lines, i);
                nodes.push(result.node);
                i += result.consumed;
                continue;
            }
            nodes.push({ type: 'command', line });
            i++;
        }
        return nodes;
    }

    _parseIf(lines, start) {
        const parseCondition = str => str
            .replace(/^(?:if|elif)\s+/, '')
            .replace(/\s*;\s*then\s*$/, '')
            .replace(/\s+then\s*$/, '')
            .trim();

        const clauses = [{ condition: parseCondition(lines[start].trim()), bodyLines: [] }];
        const elseLines = [];
        let currentClause = clauses[0];
        let inElse = false;
        let depth = 1;

        let i = start + 1;
        if (i < lines.length && lines[i].trim() === 'then') i++;

        while (i < lines.length) {
            const line = lines[i].trim();

            if (line.startsWith('if ') || line === 'if') depth++;

            if (line === 'fi') {
                depth--;
                if (depth === 0) { i++; break; }
            }

            if (depth === 1 && line.startsWith('elif ')) {
                const newClause = { condition: parseCondition(line), bodyLines: [] };
                clauses.push(newClause);
                currentClause = newClause;
                i++;
                if (i < lines.length && lines[i].trim() === 'then') i++;
                continue;
            }

            if (depth === 1 && line === 'else') {
                inElse = true;
                i++; continue;
            }

            if (inElse) elseLines.push(lines[i]);
            else currentClause.bodyLines.push(lines[i]);
            i++;
        }

        return { node: { type: 'if', clauses, elseLines }, consumed: i - start };
    }

    _parseWhile(lines, start) {
        let condition = lines[start].trim()
            .replace(/^while\s+/, '')
            .replace(/\s*;\s*do\s*$/, '')
            .replace(/\s+do\s*$/, '')
            .trim();

        let i = start + 1;
        if (i < lines.length && lines[i].trim() === 'do') i++;

        const bodyLines = [];
        let depth = 1;

        while (i < lines.length) {
            const line = lines[i].trim();
            if (line.startsWith('while ') || line.startsWith('for ')) depth++;
            if (line === 'done') {
                depth--;
                if (depth === 0) { i++; break; }
            }
            bodyLines.push(lines[i]);
            i++;
        }

        return { node: { type: 'while', condition, bodyLines }, consumed: i - start };
    }

    _parseFor(lines, start) {
        const firstLine = lines[start].trim()
            .replace(/\s*;\s*do\s*$/, '')
            .replace(/\s+do\s*$/, '');
        const match = firstLine.match(/^for\s+(\w+)\s+in\s+(.+)$/);
        const variable = match ? match[1] : '';
        const list = match ? match[2].trim() : '';

        let i = start + 1;
        if (i < lines.length && lines[i].trim() === 'do') i++;

        const bodyLines = [];
        let depth = 1;

        while (i < lines.length) {
            const line = lines[i].trim();
            if (line.startsWith('while ') || line.startsWith('for ')) depth++;
            if (line === 'done') {
                depth--;
                if (depth === 0) { i++; break; }
            }
            bodyLines.push(lines[i]);
            i++;
        }

        return { node: { type: 'for', variable, list, bodyLines }, consumed: i - start };
    }

    _executeNodes(nodes) {
        return nodes.reduce((chain, node) => {
            return chain.then(() => this._executeNode(node));
        }, Promise.resolve());
    }

    _executeNode(node) {
        if (node.type === 'function') {
            const funcName = node.name;
            const funcBody = node.bodyLines;
            const self = this;
            const LocalCmdBase = require('./local/LocalCommand');
            const FuncCmd = class extends LocalCmdBase {
                static get name() { return funcName; }
                run() {
                    // Set positional parameters ($1, $2, ...) from call arguments
                    const saved = this.arguments.map((arg, i) => ({
                        key: String(i + 1),
                        prev: self.sandbox.context.getVar(String(i + 1))
                    }));
                    this.arguments.forEach((arg, i) =>
                        self.sandbox.context.setVar(String(i + 1), arg));
                    const restore = () => saved.forEach(({ key, prev }) =>
                        prev ? self.sandbox.context.setVar(key, prev)
                             : self.sandbox.context.unsetVar(key));
                    return self._executeFunctionBody(funcBody)
                        .then(() => { restore(); })
                        .catch(e => {
                            restore();
                            if (e && e.__type === 'return') {
                                this.exitCode = e.code;
                                return;
                            }
                            return Promise.reject(e);
                        });
                }
            };
            this.sandbox.context.setCommand(FuncCmd);
            return Promise.resolve();
        }
        if (node.type === 'command') {
            // Intercept 'return [n]' before it reaches the sandbox
            if (/^return(\s+\d+)?\s*$/.test(node.line.trim())) {
                const match = node.line.trim().match(/^return\s+(\d+)/);
                const code = match ? parseInt(match[1], 10) : 0;
                return Promise.reject({ __type: 'return', code });
            }
            return this.sandbox.onCommand(node.line, false);
        }
        if (node.type === 'if') return this._executeIf(node);
        if (node.type === 'while') return this._executeWhile(node);
        if (node.type === 'for') return this._executeFor(node);
        if (node.type === 'case') return this._executeCase(node);
        return Promise.resolve();
    }

    _executeIf(node) {
        const tryClause = (i) => {
            if (i >= node.clauses.length) {
                return node.elseLines.length > 0
                    ? this._executeNodes(this._parseLines(node.elseLines))
                    : Promise.resolve();
            }
            const clause = node.clauses[i];
            return this.sandbox.onCommand(clause.condition, false).then(() => {
                if (this.sandbox.lastCode === 0) {
                    return this._executeNodes(this._parseLines(clause.bodyLines));
                }
                return tryClause(i + 1);
            });
        };
        return tryClause(0);
    }

    _executeWhile(node) {
        const step = () => this.sandbox.onCommand(node.condition, false).then(() => {
            if (this.sandbox.lastCode === 0) {
                return this._executeNodes(this._parseLines(node.bodyLines)).then(step);
            }
        });
        return step();
    }

    _executeFor(node) {
        const expanded = node.list.replace(/\${?([\w\d]+)}?/g, (m, name) =>
            this.sandbox.context.getVar(name) || '');
        const items = expanded.split(/\s+/).filter(Boolean);
        return items.reduce((chain, value) => {
            return chain.then(() => {
                this.sandbox.context.setVar(node.variable, value);
                return this._executeNodes(this._parseLines(node.bodyLines));
            });
        }, Promise.resolve());
    }

    _parseFunction(lines, start) {
        const line = lines[start].trim();
        const nameMatch = line.match(/^function\s+([\w\d_]+)/)
            || line.match(/^([\w\d_]+)\s*\(/);
        const name = nameMatch ? nameMatch[1] : '';

        let i = start + 1;
        // If opening brace not on the definition line, find it
        if (!line.includes('{')) {
            while (i < lines.length && !lines[i].includes('{')) i++;
            i++; // skip the { line
        }

        const bodyLines = [];
        let depth = 1;
        while (i < lines.length) {
            const trimmed = lines[i].trim();
            if (trimmed === '}') { i++; break; }
            // Track nested brace depth
            const opens = (lines[i].match(/\{/g) || []).length;
            const closes = (lines[i].match(/\}/g) || []).length;
            depth += opens - closes;
            if (depth <= 0) { i++; break; }
            bodyLines.push(lines[i]);
            i++;
        }

        return { node: { type: 'function', name, bodyLines }, consumed: i - start };
    }

    _parseCase(lines, start) {
        const firstLine = lines[start].trim();
        const match = firstLine.match(/^case\s+(.+?)\s+in\s*$/);
        const word = match ? match[1] : '';

        let i = start + 1;
        const clauses = [];
        let currentPattern = null;
        let currentBody = [];

        while (i < lines.length) {
            const raw = lines[i];
            const line = raw.trim();
            i++;

            if (!line || line.startsWith('#')) continue;
            if (line === 'esac') break;

            if (currentPattern === null) {
                // Pattern line: "pattern) rest" or "pattern)"
                const patMatch = line.match(/^(.+?)\)\s*(.*)$/);
                if (patMatch) {
                    currentPattern = patMatch[1].trim();
                    const rest = patMatch[2].trim();
                    if (rest === ';;') {
                        clauses.push({ pattern: currentPattern, bodyLines: [] });
                        currentPattern = null;
                    } else if (rest.endsWith(';;')) {
                        const body = rest.slice(0, -2).trim();
                        clauses.push({ pattern: currentPattern, bodyLines: body ? [body] : [] });
                        currentPattern = null;
                    } else if (rest) {
                        currentBody = [rest];
                    } else {
                        currentBody = [];
                    }
                }
            } else if (line === ';;') {
                clauses.push({ pattern: currentPattern, bodyLines: currentBody });
                currentPattern = null;
                currentBody = [];
            } else if (line.endsWith(';;')) {
                currentBody.push(line.slice(0, -2).trim());
                clauses.push({ pattern: currentPattern, bodyLines: currentBody });
                currentPattern = null;
                currentBody = [];
            } else {
                currentBody.push(raw);
            }
        }

        // Handle an unclosed final clause
        if (currentPattern !== null) {
            clauses.push({ pattern: currentPattern, bodyLines: currentBody });
        }

        return { node: { type: 'case', word, clauses }, consumed: i - start };
    }

    _executeFunctionBody(bodyLines) {
        return this._executeNodes(this._parseLines(bodyLines));
    }

    _executeCase(node) {
        return this.sandbox._replaceVariables(node.word).then(expanded => {
            // Strip outer quotes produced by variable expansion
            const value = ((expanded.startsWith('"') && expanded.endsWith('"'))
                || (expanded.startsWith("'") && expanded.endsWith("'")))
                ? expanded.slice(1, -1) : expanded;

            for (const clause of node.clauses) {
                if (this._matchPattern(clause.pattern, value)) {
                    return this._executeNodes(this._parseLines(clause.bodyLines));
                }
            }
        });
    }

    _matchPattern(pattern, value) {
        let regexStr = '';
        let i = 0;
        while (i < pattern.length) {
            const ch = pattern[i];
            if (ch === '[') {
                const end = pattern.indexOf(']', i + 1);
                if (end !== -1) {
                    regexStr += pattern.slice(i, end + 1);
                    i = end + 1;
                } else {
                    regexStr += '\\[';
                    i++;
                }
            } else if (ch === '*') {
                regexStr += '.*';
                i++;
            } else if (ch === '?') {
                regexStr += '.';
                i++;
            } else if (/[.+^${}()|\\]/.test(ch)) {
                regexStr += '\\' + ch;
                i++;
            } else {
                regexStr += ch;
                i++;
            }
        }
        try {
            return new RegExp('^' + regexStr + '$').test(value);
        } catch (_) {
            return false;
        }
    }
}

module.exports = ScriptCommand;
module.exports.isKnownInterpreter = isKnownInterpreter;

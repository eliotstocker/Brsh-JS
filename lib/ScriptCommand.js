'use strict';

const LocalCommand = require('./local/LocalCommand');

class ScriptCommand extends LocalCommand {
    constructor(script, args, context, source = false) {
        super(args, context);
        this.script = script;
        this.source = source;
    }

    run() {
        this.sandbox = new global.shell({
            cwd: this.context.fs.cwd,
            filesystem: this.context.fs.getRaw(),
            permissions: this.context.fs.getRawPermissions()
        });
        this.sandbox.context.source(this.context);

        this.sandbox.on('stdOut', data => this.stdOut = data);
        this.sandbox.on('stdErr', data => this.stdErr = data);

        const lines = this.script.split(/\r?\n/);

        if(!lines[0].startsWith('#!')) {
            return Promise.reject('no interpreter set');
        }

        const nodes = this._parseLines(lines.slice(1));
        return this._executeNodes(nodes).then(() => {
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
            nodes.push({ type: 'command', line });
            i++;
        }
        return nodes;
    }

    _parseIf(lines, start) {
        let condition = lines[start].trim()
            .replace(/^if\s+/, '')
            .replace(/\s*;\s*then\s*$/, '')
            .replace(/\s+then\s*$/, '')
            .trim();

        let i = start + 1;
        if (i < lines.length && lines[i].trim() === 'then') i++;

        const thenLines = [], elseLines = [];
        let inElse = false, inElif = false;
        let depth = 1;

        while (i < lines.length) {
            const line = lines[i].trim();

            if (line.startsWith('if ')) depth++;

            if (line === 'fi') {
                depth--;
                if (depth === 0) {
                    if (inElif) elseLines.push('fi');
                    i++; break;
                }
            }

            if (depth === 1 && (line === 'else' || line.startsWith('elif '))) {
                if (!inElse) inElse = true;
                if (line.startsWith('elif ')) {
                    inElif = true;
                    elseLines.push(line.replace(/^elif/, 'if'));
                } else if (inElif) {
                    // 'else' after an elif belongs to the inner if
                    elseLines.push(lines[i]);
                }
                i++; continue;
            }

            if (inElse) elseLines.push(lines[i]);
            else thenLines.push(lines[i]);
            i++;
        }

        return { node: { type: 'if', condition, thenLines, elseLines }, consumed: i - start };
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
        if (node.type === 'command') {
            return this.sandbox.onCommand(node.line, false);
        }
        if (node.type === 'if') return this._executeIf(node);
        if (node.type === 'while') return this._executeWhile(node);
        if (node.type === 'for') return this._executeFor(node);
        return Promise.resolve();
    }

    _executeIf(node) {
        return this.sandbox.onCommand(node.condition, false).then(() => {
            if (this.sandbox.lastCode === 0) {
                return this._executeNodes(this._parseLines(node.thenLines));
            } else if (node.elseLines.length > 0) {
                return this._executeNodes(this._parseLines(node.elseLines));
            }
        });
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
}

module.exports = ScriptCommand;

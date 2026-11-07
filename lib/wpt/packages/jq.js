'use strict';

const Command = require('../../Command');
const { loadModule } = require('../utils');

function createJqCommand(pkgMeta, wptConfig = {}) {
    class JqCommand extends Command {
        static get name() { return pkgMeta.bin || 'jq'; }
        get name() { return pkgMeta.bin || 'jq'; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.includes('--help') || args.includes('-h')) {
                [
                    `jq - commandline JSON processor [version ${pkgMeta.version} WASM]`,
                    'Usage: jq [options] <jq filter> [file...]',
                    '',
                    'Options:',
                    '  -r, --raw-output     output raw strings, not JSON texts',
                    '  -c, --compact-output compact instead of pretty-printed output',
                    '  -s, --slurp          read (slurp) all inputs into an array',
                    '  -n, --null-input     use `null` as the single input value',
                    '  -V, --version        show the version'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (args.includes('--version') || args.includes('-V') || args.includes('-v')) {
                this.stdOut = `jq-${pkgMeta.version}`;
                return;
            }

            const flags = [];
            let filter = null;
            const files = [];

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a.startsWith('-') && filter === null) {
                    flags.push(a);
                } else if (filter === null) {
                    filter = a;
                } else {
                    files.push(a);
                }
            }

            if (filter === null) {
                filter = '.';
            }

            const rawOutput = flags.includes('-r') || flags.includes('--raw-output');
            const compactOutput = flags.includes('-c') || flags.includes('--compact-output');
            const nullInput = flags.includes('-n') || flags.includes('--null-input');

            let inputText = '';
            if (nullInput) {
                inputText = 'null';
            } else if (files.length > 0) {
                const chunks = [];
                for (const file of files) {
                    const content = this.fs.getFileByPath(file);
                    if (content == null) {
                        this.stdErr = `jq: error: Could not open file ${file}: No such file or directory`;
                        this.exitCode = 2;
                        return;
                    }
                    chunks.push(typeof content === 'string' ? content : new TextDecoder().decode(content));
                }
                inputText = chunks.join('\n');
            } else if (this.stdin !== undefined && this.stdin !== null) {
                inputText = String(this.stdin);
            } else {
                this.stdErr = 'jq: error: no JSON input provided (pipe JSON or specify a file)';
                this.exitCode = 2;
                return;
            }

            try {
                const mod = await loadModule('jq-web', pkgMeta.cdnUrl, wptConfig.moduleLoader);
                const jq = await Promise.resolve(mod.default || mod);

                if (typeof jq.raw === 'function') {
                    const out = await jq.raw(inputText.trim(), filter, flags);
                    if (out !== undefined && out !== null) {
                        String(out).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                    }
                    return;
                }

                if (typeof jq.json === 'function') {
                    const parsedInput = JSON.parse(inputText);
                    const res = await jq.json(parsedInput, filter, flags);
                    this._emitFormatted(res, rawOutput, compactOutput);
                    return;
                }

                throw new Error('Invalid jq WASM module interface');
            } catch (err) {
                this.stdErr = `jq: error: ${err.message || err}`;
                this.exitCode = 5;
            }
        }

        _emitFormatted(val, rawOutput, compactOutput) {
            if (val === undefined) return;
            if (rawOutput && typeof val === 'string') {
                val.split(/\r?\n/).forEach(l => { this.stdOut = l; });
                return;
            }
            const formatted = compactOutput
                ? JSON.stringify(val)
                : JSON.stringify(val, null, 2);
            if (formatted !== undefined) {
                formatted.split(/\r?\n/).forEach(l => { this.stdOut = l; });
            }
        }
    }

    return JqCommand;
}

module.exports = createJqCommand;

'use strict';

const Command = require('../../Command');
const { loadModule } = require('../utils');

function createGraphvizCommand(pkgMeta, wptConfig = {}, binName = 'dot') {
    class GraphvizCommand extends Command {
        static get name() { return binName; }
        get name() { return binName; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.includes('--help') || args.includes('-h') || args.includes('-?')) {
                [
                    `Usage: ${binName} [-Tformat] [-ooutfile] [files]`,
                    'Options:',
                    '  -T<format>           Set output format (svg, dot, json, canon, plain)',
                    '  -K<engine>           Set layout engine (dot, neato, fdp, sfdp, twopi, circo)',
                    '  -o <file>            Write output to <file> (default: stdout)',
                    '  -V, --version        Print version and exit'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (args.includes('-V') || args.includes('--version') || args.includes('-v')) {
                this.stdOut = `dot - graphviz version ${pkgMeta.version} (WASM)`;
                return;
            }

            let format = 'svg';
            let engine = 'dot';
            let outputFile = null;
            const inputFiles = [];

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a.startsWith('-T') && a.length > 2) {
                    format = a.slice(2);
                } else if (a === '-T' && i + 1 < args.length) {
                    format = args[++i];
                } else if (a.startsWith('-K') && a.length > 2) {
                    engine = a.slice(2);
                } else if (a === '-K' && i + 1 < args.length) {
                    engine = args[++i];
                } else if (a.startsWith('-o') && a.length > 2) {
                    outputFile = a.slice(2);
                } else if ((a === '-o' || a === '--output') && i + 1 < args.length) {
                    outputFile = args[++i];
                } else if (!a.startsWith('-')) {
                    inputFiles.push(a);
                }
            }

            let dotSource = '';
            if (inputFiles.length > 0) {
                const chunks = [];
                for (const file of inputFiles) {
                    const content = this.fs.getFileByPath(file);
                    if (content == null) {
                        this.stdErr = `Error: ${binName}: can't open ${file}: No such file or directory`;
                        this.exitCode = 2;
                        return;
                    }
                    chunks.push(typeof content === 'string' ? content : new TextDecoder().decode(content));
                }
                dotSource = chunks.join('\n');
            } else if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim()) {
                dotSource = String(this.stdin);
            } else {
                this.stdErr = `Error: ${binName}: no input graph provided (pass a .dot file or pipe via stdin)`;
                this.exitCode = 1;
                return;
            }

            try {
                const mod = await loadModule('@hpcc-js/wasm-graphviz', pkgMeta.cdnUrl, wptConfig.moduleLoader);
                const Graphviz = mod.Graphviz || (mod.default && mod.default.Graphviz) || mod.default || mod;
                const gv = typeof Graphviz.load === 'function' ? await Graphviz.load() : Graphviz;

                const output = await gv.layout(dotSource, format, engine);

                if (outputFile) {
                    this.fs.setFileByPath(outputFile, String(output), true);
                } else {
                    String(output).replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                }
            } catch (err) {
                this.stdErr = `Error: ${binName}: ${err.message || err}`;
                this.exitCode = 1;
            }
        }
    }

    return GraphvizCommand;
}

module.exports = createGraphvizCommand;

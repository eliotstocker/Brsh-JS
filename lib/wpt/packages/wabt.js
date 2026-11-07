'use strict';

const Command = require('../../Command');
const { readBytesFromFs, writeBytesToFs, loadModule } = require('../utils');

function createWabtCommand(pkgMeta, wptConfig = {}, mode = 'wat2wasm') {
    class WabtCommand extends Command {
        static get name() { return mode; }
        get name() { return mode; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
                if (mode === 'wasm2wat') {
                    this.stdOut = `usage: wasm2wat [options] filename\nOptions:\n  -o, --output=FILE    Output WAT file`;
                } else {
                    this.stdOut = `usage: wat2wasm [options] filename\nOptions:\n  -o, --output=FILE    Output WASM binary file`;
                }
                return;
            }

            if (args.includes('--version') || args.includes('-v')) {
                this.stdOut = pkgMeta.version;
                return;
            }

            let inputFile = null;
            let outputFile = null;

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if ((a === '-o' || a === '--output') && i + 1 < args.length) {
                    outputFile = args[++i];
                } else if (a.startsWith('--output=')) {
                    outputFile = a.slice('--output='.length);
                } else if (!a.startsWith('-')) {
                    inputFile = a;
                }
            }

            if (!inputFile) {
                this.stdErr = `${mode}: expected input filename`;
                this.exitCode = 1;
                return;
            }

            try {
                const wabtMod = await loadModule('wabt', pkgMeta.cdnUrl, wptConfig.moduleLoader);
                const wabtInit = wabtMod.default ?? wabtMod;
                const wabt = typeof wabtInit === 'function' ? await wabtInit() : wabtInit;

                if (mode === 'wasm2wat') {
                    const bytes = readBytesFromFs(this.fs, inputFile);
                    if (!bytes) {
                        this.stdErr = `${mode}: ${inputFile}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    const parsed = wabt.readWasm(bytes, { readDebugNames: true });
                    const watText = parsed.toText({ foldExprs: false, inlineExport: false });
                    if (outputFile) {
                        this.fs.setFileByPath(outputFile, watText, true);
                    } else {
                        watText.replace(/\r?\n$/, '').split(/\r?\n/).forEach(l => { this.stdOut = l; });
                    }
                } else {
                    const content = this.fs.getFileByPath(inputFile);
                    if (content == null) {
                        this.stdErr = `${mode}: ${inputFile}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
                    const parsed = wabt.parseWat(inputFile, text, { mutable_globals: true });
                    const { buffer } = parsed.toBinary({});
                    const outPath = outputFile || inputFile.replace(/\.wat$/i, '') + '.wasm';
                    writeBytesToFs(this.fs, outPath, new Uint8Array(buffer), 'application/wasm');
                    try { this.fs.setMode(outPath, 0o755); } catch { /* ignore */ }
                }
            } catch (err) {
                this.stdErr = `${mode}: ${err.message || err}`;
                this.exitCode = 1;
            }
        }
    }

    return WabtCommand;
}

module.exports = createWabtCommand;

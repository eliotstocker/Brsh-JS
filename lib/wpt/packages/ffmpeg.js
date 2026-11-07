'use strict';

const Command = require('../../Command');
const { readBytesFromFs, writeBytesToFs, loadModule } = require('../utils');

function createFfmpegCommand(pkgMeta, wptConfig = {}) {
    class FfmpegCommand extends Command {
        static get name() { return pkgMeta.bin || 'ffmpeg'; }
        get name() { return pkgMeta.bin || 'ffmpeg'; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];

            if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
                [
                    `ffmpeg version ${pkgMeta.version}-wasm Copyright (c) 2000-2026 the FFmpeg developers`,
                    'Hyper fast Audio and Video encoder (WebAssembly build)',
                    'usage: ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...',
                    '',
                    'Options:',
                    '  -i <file>            input file path in brsh filesystem',
                    '  -f <fmt>             force input or output file format',
                    '  -c / -codec <codec>  codec name',
                    '  -version             show version'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (args.includes('-version') || args.includes('--version') || args.includes('-v')) {
                this.stdOut = `ffmpeg version ${pkgMeta.version}-wasm`;
                return;
            }

            // Identify input files (`-i <file>`) and output file (last non-flag token not preceded by an option flag)
            const inputFiles = [];
            let outputFile = null;
            const flagsWithValue = new Set(['-i', '-f', '-c', '-codec', '-c:v', '-c:a', '-b:v', '-b:a', '-r', '-s', '-t', '-ss', '-vf', '-af', '-ar', '-ac']);

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-i' && i + 1 < args.length) {
                    inputFiles.push(args[++i]);
                } else if (flagsWithValue.has(a) && i + 1 < args.length) {
                    i++;
                } else if (!a.startsWith('-')) {
                    outputFile = a;
                }
            }

            try {
                const mod = await loadModule('@ffmpeg/ffmpeg', pkgMeta.cdnUrl, wptConfig.moduleLoader);
                const FFmpeg = mod.FFmpeg || (mod.default && mod.default.FFmpeg) || mod.default || mod;
                const ffmpeg = typeof FFmpeg === 'function' ? new FFmpeg() : FFmpeg;

                if (typeof ffmpeg.on === 'function') {
                    ffmpeg.on('log', ({ message }) => {
                        if (message) this.stdOut = message;
                    });
                }

                if (!ffmpeg.loaded && typeof ffmpeg.load === 'function') {
                    await ffmpeg.load({
                        coreURL: pkgMeta.coreUrl
                    });
                }

                // Stage input files from brsh filesystem into FFmpeg virtual FS
                for (const inPath of inputFiles) {
                    const bytes = readBytesFromFs(this.fs, inPath);
                    if (!bytes) {
                        this.stdErr = `${inPath}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    await ffmpeg.writeFile(inPath, bytes);
                }

                const exitCode = await ffmpeg.exec(args);
                if (typeof exitCode === 'number' && exitCode !== 0) {
                    this.exitCode = exitCode;
                    return;
                }

                // Copy output file back into brsh filesystem
                if (outputFile && typeof ffmpeg.readFile === 'function') {
                    const outData = await ffmpeg.readFile(outputFile);
                    if (outData) {
                        const outBytes = outData instanceof Uint8Array
                            ? outData
                            : new TextEncoder().encode(String(outData));
                        writeBytesToFs(this.fs, outputFile, outBytes, 'application/octet-stream');
                    }
                }
            } catch (err) {
                this.stdErr = `ffmpeg: ${err.message || err}`;
                this.exitCode = 1;
            }
        }
    }

    return FfmpegCommand;
}

module.exports = createFfmpegCommand;

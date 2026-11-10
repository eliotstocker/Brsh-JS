#!/usr/bin/env node
'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cla = require('command-line-args');
const tmp = require('tmp');
const { polyfillNode } = require('esbuild-plugin-polyfill-node');
const { buildStructure } = require('../lib/buildFilesystemStructure');
const { serializeBinaryFilesystem } = require('../lib/BinaryContainer');
const { SymlinkRef } = require('../lib/BaseFileSystem');

let options;
try {
    options = cla([
        {
            name: 'root',
            defaultOption: true,
            type: String,
            required: true
        },
        {
            name: 'variable',
            alias: 'v',
            required: false,
            type: String
        },
        {
            name: 'output',
            alias: 'o',
            type: String
        },
        {
            name: 'pretty',
            alias: 'p',
            type: Boolean
        },
        {
            name: 'hyperlinks',
            alias: 'h',
            type: Boolean
        },
        {
            name: 'compress',
            alias: 'c',
            type: Boolean
        },
        {
            name: 'binary',
            alias: 'b',
            type: Boolean
        }
    ]);
} catch(e) {
    console.error(e.message);
    process.exit(1);
}

if(!options.root) {
    console.log('missing required directory root');
    process.exit(1);
}

const isStandaloneBrfsOutput = Boolean(options.output && options.output.endsWith('.brfs'));
const useBinaryContainer = Boolean(options.binary || isStandaloneBrfsOutput);

if(!options.variable && !isStandaloneBrfsOutput) {
    console.log('missing required --variable (-v) flag');
    process.exit(1);
}

try {
    fs.accessSync(options.root, fs.constants.R_OK);
} catch(e) {
    console.log('cant access specified root directory');
    process.exit(1);
}

let struct;
try {
    struct = buildStructure(options.root);
} catch(e) {
    console.log('cant access specified directory');
    process.exit(1);
}
const { filesystem, permissions } = struct;

if ((options.compress || options.binary) && !options.output) {
    console.log('--compress / --binary requires --output (-o) to be set');
    process.exit(1);
}

const alias = {
    'supports-color': 'supports-color/index',
};

if(options.hyperlinks) {
    alias['supports-hyperlinks'] = 'supports-hyperlinks/index';
}

const textLoaderPlugin = {
    name: 'textLoader',
    setup(build) {
        build.onLoad({ filter: /.*$/ }, async (args) => {
            const filename = path.basename(args.path);
            if (!filename.endsWith('.js')
                && !filename.endsWith('.json')
                && !filename.endsWith('.ts')
                && !filename.endsWith('.gif')
                && !filename.endsWith('.png')
                && !filename.endsWith('.jpg')
                && !filename.endsWith('.jpeg')
                && !filename.endsWith('.bmp')
                && !filename.endsWith('.webp')
                && !filename.endsWith('.ico')
                && !filename.endsWith('.wasm')
            ) {
                const contents = await fs.promises.readFile(args.path, 'utf8');
                return { contents, loader: 'text' };
            }
        });
    }
};

const brshGlobalsPlugin = {
    name: 'brshGlobals',
    setup(build) {
        const BRSH_FILTER = /(^brsh(\/.*)?$|(\/|^)(Command|LocalCommand|WasmCommand|InteractiveCommand|ReplCommand)(\.js)?$)/;
        build.onResolve({ filter: BRSH_FILTER }, args => {
            return { path: args.path, namespace: 'brsh-globals' };
        });
        build.onLoad({ filter: /.*/, namespace: 'brsh-globals' }, args => {
            const base = path.basename(args.path, '.js');
            let exportStmt;
            if (base === 'Command') {
                exportStmt = 'module.exports = typeof Command !== "undefined" ? Command : globalThis.Command;';
            } else if (base === 'LocalCommand') {
                exportStmt = 'module.exports = typeof LocalCommand !== "undefined" ? LocalCommand : globalThis.LocalCommand;';
            } else if (base === 'WasmCommand') {
                exportStmt = 'module.exports = typeof WasmCommand !== "undefined" ? WasmCommand : globalThis.WasmCommand;';
            } else if (base === 'InteractiveCommand') {
                exportStmt = 'module.exports = typeof InteractiveCommand !== "undefined" ? InteractiveCommand : globalThis.InteractiveCommand;';
            } else if (base === 'ReplCommand') {
                exportStmt = 'module.exports = typeof ReplCommand !== "undefined" ? ReplCommand : globalThis.ReplCommand;';
            } else {
                exportStmt = `
                    const _Cmd = typeof Command !== "undefined" ? Command : globalThis.Command;
                    const _Local = typeof LocalCommand !== "undefined" ? LocalCommand : globalThis.LocalCommand;
                    const _Wasm = typeof WasmCommand !== "undefined" ? WasmCommand : globalThis.WasmCommand;
                    const _Interactive = typeof InteractiveCommand !== "undefined" ? InteractiveCommand : globalThis.InteractiveCommand;
                    const _Repl = typeof ReplCommand !== "undefined" ? ReplCommand : globalThis.ReplCommand;
                    module.exports = {
                        Command: _Cmd,
                        LocalCommand: _Local,
                        WasmCommand: _Wasm,
                        InteractiveCommand: _Interactive,
                        ReplCommand: _Repl,
                        default: _Cmd
                    };
                `;
            }
            return { contents: exportStmt, loader: 'js' };
        });
    }
};

/**
 * Bundles any `.js` files found in the filesystem structure into self-contained
 * plain UTF-8 text strings using esbuild to inline external npm dependencies,
 * mapping brsh base classes to runtime parameters.
 */
async function bundleJsFiles(node, virtualPrefix, hostPrefix) {
    for (const [key, value] of Object.entries(node)) {
        const vPath = `${virtualPrefix}/${key}`;
        const hostPath = path.join(hostPrefix, key);
        if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof SymlinkRef)) {
            await bundleJsFiles(value, vPath, hostPath);
        } else if (key.endsWith('.js') && typeof value === 'string') {
            try {
                const result = await esbuild.build({
                    entryPoints: [hostPath],
                    bundle: true,
                    format: 'cjs',
                    platform: 'browser',
                    write: false,
                    minify: !options.pretty,
                    sourcemap: false,
                    plugins: [brshGlobalsPlugin, textLoaderPlugin, polyfillNode()],
                    define: {
                        'process.env.NODE_ENV': JSON.stringify('production'),
                        'process.env.COLORTERM': JSON.stringify('truecolor'),
                        'process.env.TERM': JSON.stringify('color'),
                        'process.env.FORCE_HYPERLINK': options.hyperlinks ? JSON.stringify('true') : JSON.stringify('false'),
                    },
                    alias,
                });
                if (result.outputFiles && result.outputFiles[0]) {
                    node[key] = result.outputFiles[0].text;
                }
            } catch (err) {
                // If esbuild fails to bundle (e.g. dynamic require), preserve existing file string
            }
        }
    }
}

async function buildBinaryContainerMode() {
    await bundleJsFiles(filesystem, '', options.root);

    const rawContainer = serializeBinaryFilesystem(filesystem, permissions);
    const finalBytes = options.compress ? zlib.gzipSync(Buffer.from(rawContainer)) : Buffer.from(rawContainer);

    if (isStandaloneBrfsOutput) {
        fs.writeFileSync(options.output, finalBytes);
        console.log(`Binary container written to ${options.output}`);
        console.log('Build succeeded');
        return;
    }

    // Output is a `.js` file with `--binary`: write `.brfs` alongside a tiny browser loader
    const brfsPath = options.output.replace(/\.js$/, '') + '.brfs';
    fs.writeFileSync(brfsPath, finalBytes);

    const varName = options.variable;
    const loader =
        `globalThis.${varName}=(function(){` +
        `var s=typeof document!=="undefined"&&document.currentScript?document.currentScript.src:` +
            `typeof location!=="undefined"?location.href:null;` +
        `if(!s)throw new Error("${varName}: cannot resolve .brfs URL");` +
        `var u=s.replace(/\\.js(\\?[^#]*)?$/,".brfs");` +
        `return fetch(u)` +
            `.then(function(r){return r.arrayBuffer();})` +
            `.then(function(b){` +
                `var u8=new Uint8Array(b);` +
                `if(u8[0]===0x1f&&u8[1]===0x8b){` +
                    `var ds=new DecompressionStream("gzip");` +
                    `var w=ds.writable.getWriter();` +
                    `w.write(u8);w.close();` +
                    `return new Response(ds.readable).arrayBuffer().then(function(ab){return {filesystem:new Uint8Array(ab),permissions:{}};});` +
                `}` +
                `return {filesystem:u8,permissions:{}};` +
            `});` +
        `})();`;
    fs.writeFileSync(options.output, loader);
    console.log(`Binary container written to ${brfsPath}`);
    console.log('Build succeeded');
}

async function buildLegacyJsMode() {
    await bundleJsFiles(filesystem, '', options.root);

    const fsJson = JSON.stringify(filesystem, null, options.pretty ? 2 : null);
    const permJson = JSON.stringify(permissions, null, options.pretty ? 2 : null);

    const JS = `module.exports = { filesystem: ${fsJson}, permissions: ${permJson} };`;

    const tf = tmp.fileSync({ postfix: '.tmp.js' });
    fs.writeFileSync(tf.name, JS);

    await esbuild.build({
        entryPoints: [tf.name],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        treeShaking: true,
        outfile: options.output,
        allowOverwrite: true,
        globalName: options.variable,
        minify: !options.pretty,
        sourcemap: false,
        plugins: [
            textLoaderPlugin,
            polyfillNode()
        ],
        define: {
            'process.env.NODE_ENV': JSON.stringify('production'),
            'process.env.COLORTERM': JSON.stringify('truecolor'),
            'process.env.TERM': JSON.stringify('color'),
            'process.env.FORCE_HYPERLINK': options.hyperlinks ? JSON.stringify('true') : JSON.stringify('false'),
        },
        alias,
    });

    if (options.compress) {
        const bundle = fs.readFileSync(options.output, 'utf8');
        const codeToCompress = bundle + `\nreturn ${options.variable};`;
        const compressed = zlib.gzipSync(Buffer.from(codeToCompress, 'utf8'));
        const gzPath = options.output.replace(/\.js$/, '') + '.brfs';
        fs.writeFileSync(gzPath, compressed);

        const varName = options.variable;
        const loader =
            `globalThis.${varName}=(function(){` +
            `var s=typeof document!=="undefined"&&document.currentScript?document.currentScript.src:` +
                `typeof location!=="undefined"?location.href:null;` +
            `if(!s)throw new Error("${varName}: cannot resolve .brfs URL");` +
            `var u=s.replace(/\\.js(\\?[^#]*)?$/,".brfs");` +
            `return fetch(u)` +
                `.then(function(r){return r.arrayBuffer();})` +
                `.then(function(b){` +
                    `var ds=new DecompressionStream("gzip");` +
                    `var w=ds.writable.getWriter();` +
                    `w.write(new Uint8Array(b));` +
                    `w.close();` +
                    `return new Response(ds.readable).text();` +
                `})` +
                `.then(function(code){return new Function(code)();});` +
            `})();`;
        fs.writeFileSync(options.output, loader);
        console.log(`Compressed bundle written to ${gzPath}`);
    }
    console.log('Build succeeded');
}

if (useBinaryContainer) {
    buildBinaryContainerMode().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    buildLegacyJsMode().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

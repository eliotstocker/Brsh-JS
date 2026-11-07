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
            required: true,
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

if(!options.variable) {
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

if (options.compress && !options.output) {
    console.log('--compress requires --output (-o) to be set');
    process.exit(1);
}

const fsJson = JSON.stringify(filesystem, null, options.pretty ? 2 : null);
const permJson = JSON.stringify(permissions, null, options.pretty ? 2 : null);
const fsJS = fsJson.replace(/"(require\('.*?'\))"/gm, '$1');

const JS = `module.exports = { filesystem: ${fsJS}, permissions: ${permJson} }`;

const tf = tmp.fileSync({ postfix: '.tmp.js' });
fs.writeFileSync(tf.name, JS);

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

esbuild.build({
    entryPoints: [tf.name],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    treeShaking: true,
    outfile: options.output,
    allowOverwrite: true,
    globalName: options.variable,
    minify: true,
    sourcemap: false,
    loader: {
        '.gif': 'binary',
        '.png': 'binary',
        '.jpg': 'binary',
        '.jpeg': 'binary',
        '.bmp': 'binary',
        '.webp': 'binary',
        '.ico': 'binary',
        '.wasm': 'binary'
    },
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
})
    .then(() => {
        if (options.compress) {
            // Post-process: gzip the entire esbuild output.
            // The compressed bytes are written to <output>.gz as raw binary.
            // The JS file is replaced with a tiny loader that fetches the .gz,
            // decompresses it, and executes it — no base64 overhead.
            const bundle = fs.readFileSync(options.output, 'utf8');
            // Append a return statement so new Function() can hand back the value
            const codeToCompress = bundle + `\nreturn ${options.variable};`;
            const compressed = zlib.gzipSync(Buffer.from(codeToCompress, 'utf8'));
            const gzPath = options.output.replace(/\.js$/, '') + '.brfs';
            fs.writeFileSync(gzPath, compressed);

            const varName = options.variable;
            // The loader captures document.currentScript.src synchronously
            // (unavailable once the async IIFE runs) and derives the .brfs URL.
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
    });

#!/usr/bin/env node
'use strict';

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
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
let json = JSON.stringify(struct, null, options.pretty ? 2 : null);

let JS = 'module.exports = ' + json.replace(/"(require\('.*?'\))"/gm, '$1');

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
        '.bmp': 'binary'
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
        console.log('Build succeeded');
    });

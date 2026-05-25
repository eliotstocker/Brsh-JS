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

/**
 * Recursively splits a filesystem tree into two trees:
 *   code  – entries whose value is a require() placeholder (bundled by esbuild)
 *   data  – entries whose value is a plain string/null (text / binary content)
 */
function splitFilesystem(node) {
    const code = {};
    const data = {};
    for (const [key, value] of Object.entries(node)) {
        if (value !== null && typeof value === 'object') {
            const [subCode, subData] = splitFilesystem(value);
            if (Object.keys(subCode).length > 0) code[key] = subCode;
            if (Object.keys(subData).length > 0) data[key] = subData;
        } else if (typeof value === 'string' && value.startsWith("require('")) {
            code[key] = value;
        } else {
            data[key] = value;
        }
    }
    return [code, data];
}

let JS;

if (options.compress) {
    const [codeFilesystem, dataFilesystem] = splitFilesystem(filesystem);

    // Compress the data portion (text/binary file contents + permissions)
    const dataPayload = JSON.stringify({ filesystem: dataFilesystem, permissions });
    const compressed = zlib.gzipSync(Buffer.from(dataPayload, 'utf8'));
    const b64 = compressed.toString('base64');

    // Serialise only the code portion (require() entries) with substitution
    const codeFsJSON = JSON.stringify(codeFilesystem);
    const codeFsJS = codeFsJSON.replace(/"(require\('.*?'\))"/gm, '$1');

    JS = `
const __c="${b64}";
function __bd(s){const b=atob(s);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}
async function __decompress(b64){const ds=new DecompressionStream("gzip");const w=ds.writable.getWriter();w.write(__bd(b64));w.close();const buf=await new Response(ds.readable).arrayBuffer();return JSON.parse(new TextDecoder().decode(buf));}
function __merge(a,b){const r={};const ks=new Set([...Object.keys(a||{}),...Object.keys(b||{})]);for(const k of ks){const av=a&&a[k],bv=b&&b[k];r[k]=(av!==null&&typeof av==="object"&&bv!==null&&typeof bv==="object")?__merge(av,bv):(av!==undefined?av:bv);}return r;}
const __codeFs=${codeFsJS};
module.exports=__decompress(__c).then(function(__d){return{filesystem:__merge(__codeFs,__d.filesystem),permissions:__d.permissions};});
`;
} else {
    const fsJson = JSON.stringify(filesystem, null, options.pretty ? 2 : null);
    const permJson = JSON.stringify(permissions, null, options.pretty ? 2 : null);
    const fsJS = fsJson.replace(/"(require\('.*?'\))"/gm, '$1');
    JS = `module.exports = { filesystem: ${fsJS}, permissions: ${permJson} }`;
}

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
        '.ico': 'binary'
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

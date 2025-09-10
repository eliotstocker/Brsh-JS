#!/usr/bin/env node
'use strict';

import * as esbuild from 'esbuild'

import fs from 'fs';
import path from 'path';
import cla from 'command-line-args';
import tmp from 'tmp';

import { polyfillNode } from "esbuild-plugin-polyfill-node";

const ignore = ['.DS_Store'];

let options;
try {
    options = cla([
        {
            name: "root",
            defaultOption: true,
            type: String,
            required: true
        },
        {
            name: "variable",
            alias: "v",
            required: true,
            type: String
        },
        {
            name: "output",
            alias: "o",
            type: String
        },
        {
            name: "pretty",
            alias: "p",
            type: Boolean
        },
        {
            name: "hyperlinks",
            alias: "h",
            type: Boolean
        }
    ]);
} catch(e) {
    console.error(e.message);
    process.exit(1);
}

if(!options.root) {
    console.log("missing required directory root");
    process.exit(1);
}

try {
    fs.accessSync(options.root, fs.constants.R_OK);
} catch(e) {
    console.log("cant access specified root directory");
    process.exit(1);
}

const functions = [];

function cleanFunction(code) {
    const trimmed = code.trim();
    if(trimmed.endsWith(';')) {
        return trimmed.substring(0, trimmed.length -1);
    }
    return trimmed;
}

function buildStructure(root) {
    try {
        const sub = fs.readdirSync(root);
        return sub.reduce((structure, handle) => {
            if(ignore.includes(handle)) {
                return structure;
            }
            try {
                //Check if this is a DIR
                const stat = fs.lstatSync(path.join(root, handle));
                if(stat.isDirectory()) {
                    fs.readdirSync(path.join(root, handle));
                    structure[handle] = buildStructure(path.join(root, handle));

                    return structure
                }

                //Its a file lets prepare to import
                fs.readFileSync(path.join(root, handle), 'utf8');

                if(handle.endsWith('.js')) {
                    //strip extensions form JS files
                    structure[handle.substring(0, handle.length - 3)] = `require('${path.resolve(root, handle)}')`;
                    return structure;
                }
                structure[handle] = `require('${path.resolve(root, handle)}')`;
            } catch(fe) {
                //ignore files we cant access for some reason
            }
            return structure;
        }, {});
    } catch(e) {
        console.log("cant access specified directory");
        process.exit(1);
    }
}

const struct = buildStructure(options.root);
let json = JSON.stringify(struct, null, options.pretty ? 2 : null);

//convert JSON require strings to JS
let JS = 'module.exports = ' + json.replace(/"(require\('.*?'\))"/gm, '$1');

const tf = tmp.fileSync({
    postfix: '.tmp.js'
});

//create Temp File for JS
fs.writeFileSync(tf.name, JS);

const env = {
    NODE_ENV: 'production',
    COLORTERM: 'truecolor',
    TERM: 'color',
};

const alias = {
    'supports-color': 'supports-color/index',
};

if(options.hyperlinks) {
    env.FORCE_HYPERLINK = 'true'
    alias['supports-hyperlinks'] = 'supports-hyperlinks/index'
}

let textLoaderPlugin = {
  name: 'textLoader',
  setup(build) {
    build.onLoad({ filter: /.*$/}, async (args) => {
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
          return {
            contents,
            loader: 'text'
          };
        }
    })
  }
}

const output = esbuild.build({
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
    polyfillNode({
        // Options (optional)
    }),
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

        if(!options.output) {
            process.stdout.write(output.outputFiles[0].text);
        }
    });
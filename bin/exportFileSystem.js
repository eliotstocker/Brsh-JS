#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cla = require('command-line-args');
const tmp = require('tmp');

//build deps
const webpack = require('webpack-stream');
const wp = require('webpack');
const through = require('through2');
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin");

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
    FORCE_HYPERLINK: 'true'
};

function getAllEnv() {
    return Object.entries(env).reduce((acc, [key, value]) => {
        return {
            [`process.env.${key}`]: value,
            ...acc
        }
    }, {
        'process.env': JSON.stringify(env),
        'process.stdout': JSON.stringify({
            isTTY: true
        })
    });
}

const w = webpack({
    mode: 'production',
    entry: {
        fs: tf.name,
    },
    output: {
        library: {
            name: 'fs',
            type: 'var',
        },
        filename: '[name].js'
    },
    module: {
        rules: [
            {
                test: /\.(?:gif|png|jpg|jpeg|bmp)$/i,
                type: 'asset/inline',
            },
            {
                test: function (modulePath) {
                    const handledExtensions = ['gif', 'png', 'jpg', 'jpeg', 'bmp', 'js'];

                    const handled = handledExtensions.reduce((acc, ext) => {
                        if(acc) {
                            return true;
                        }

                        if(modulePath.endsWith(ext)) {
                            return true;
                        }

                        return false;
                    }, false);

                    return !handled;
                },
                type: 'asset/source'
            },
        ],
    },
    plugins: [
        new wp.DefinePlugin(getAllEnv()),
        new NodePolyfillPlugin({
            excludeAliases: ["console"]
        }),
    ],
    optimization: {
        minimize: !options.pretty,
    },
    resolve: {
        fallback: {
            fs: false,
            net: false,
        },
        //these are for chalk so that the ansi checking passes
        alias: {
            'supports-color': 'supports-color/index',
            'supports-hyperlinks': 'supports-hyperlinks/index',
        }
    }
}, wp);

const filePipe = through.obj(function (file, enc, cb) {
    if (file.path.endsWith('.js')) {
        this.push(file.contents);
    }

    cb();
});

if(options.output) {
    const fileStream = fs.createWriteStream(options.output);
    w.pipe(filePipe).pipe(fileStream);
} else {
    w.pipe(filePipe).pipe(process.stdout);
}
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cla = require('command-line-args');
const tmp = require('tmp');

//build deps
const browserify = require('browserify');
const stringify = require('stringify');
const imgurify = require('imgurify');
const uglifyify = require('uglifyify');
const bundleCollapser = require('bundle-collapser/plugin');

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

//bundle all files into a single JS File
const b = browserify(tf.name, {
    standalone: options.variable
})
    .transform(stringify, {
        appliesTo: {
            excludeExtensions: ['.js', '.jpg', '.bmp', '.svg', '.png']
        }
    })
    .transform(imgurify)
    .plugin(bundleCollapser);

if(!options.pretty) {
    b.transform(uglifyify, {global: true});
}

if(options.output) {
    const fileStream = fs.createWriteStream(options.output);
    b.bundle().pipe(fileStream);
} else {
    b.bundle().pipe(process.stdout);
}
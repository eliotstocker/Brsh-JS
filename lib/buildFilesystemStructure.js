'use strict';

const fs = require('fs');
const path = require('path');

const IGNORE = ['.DS_Store'];

/**
 * Recursively builds a filesystem structure object from a real directory.
 * Each entry is either a nested structure (directory) or a require() string (file).
 * JS files have their .js extension stripped from the key.
 *
 * Throws if `root` cannot be read.
 */
function buildStructure(root) {
    const sub = fs.readdirSync(root);

    return sub.reduce((structure, handle) => {
        if(IGNORE.includes(handle)) {
            return structure;
        }
        try {
            const stat = fs.lstatSync(path.join(root, handle));
            if(stat.isDirectory()) {
                structure[handle] = buildStructure(path.join(root, handle));
                return structure;
            }

            // Confirm file is readable before including it
            fs.readFileSync(path.join(root, handle), 'utf8');

            if(handle.endsWith('.js')) {
                structure[handle.substring(0, handle.length - 3)] = `require('${path.resolve(root, handle)}')`;
            } else {
                structure[handle] = `require('${path.resolve(root, handle)}')`;
            }
        } catch(fe) {
            // Silently skip files/dirs that are inaccessible
        }
        return structure;
    }, {});
}

module.exports = { buildStructure, IGNORE };

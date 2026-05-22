'use strict';

const fs = require('fs');
const path = require('path');

const IGNORE = ['.DS_Store'];

/**
 * Recursively builds a filesystem structure object from a real directory.
 * Returns { filesystem, permissions } where:
 *   - filesystem is the nested content tree (directories as objects, files as require() strings)
 *   - permissions maps virtual absolute paths to Unix mode bits (e.g. { '/bin/script.sh': 0o755 })
 *
 * Throws if `root` cannot be read.
 */
function buildStructure(root) {
    const permissions = {};
    const filesystem = _buildTree(root, '', permissions);
    return { filesystem, permissions };
}

function _buildTree(root, virtualPrefix, permissions) {
    const sub = fs.readdirSync(root);

    return sub.reduce((structure, handle) => {
        if(IGNORE.includes(handle)) {
            return structure;
        }
        try {
            const stat = fs.lstatSync(path.join(root, handle));
            if(stat.isDirectory()) {
                structure[handle] = _buildTree(
                    path.join(root, handle),
                    virtualPrefix + '/' + handle,
                    permissions
                );
                return structure;
            }

            const filePath = path.join(root, handle);
            const isJavaScript = handle.endsWith('.js');
            const fileContents = isJavaScript
                ? null
                : fs.readFileSync(filePath, 'utf8');

            const key = isJavaScript
                ? handle.substring(0, handle.length - 3)
                : handle;

            structure[key] = isJavaScript
                ? `require('${path.resolve(root, handle)}')`
                : fileContents;

            // Record real Unix permission bits for this file
            permissions[virtualPrefix + '/' + key] = stat.mode & 0o777;
        } catch(fe) {
            // Silently skip files/dirs that are inaccessible
        }
        return structure;
    }, {});
}

module.exports = { buildStructure, IGNORE };

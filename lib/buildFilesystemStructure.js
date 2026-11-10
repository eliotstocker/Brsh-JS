'use strict';

const fs = require('fs');
const path = require('path');
const { SymlinkRef } = require('./BaseFileSystem');
const isUtf8Text = require('./isUtf8Text');

const IGNORE = ['.DS_Store'];

const BINARY_MIME = {
    '.gif':  'image/gif',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.bmp':  'image/bmp',
    '.webp': 'image/webp',
    '.ico':  'image/x-icon',
    '.wasm': 'application/wasm',
};

function _isWasmBuffer(buf) {
    return buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d;
}

/**
 * Recursively builds a filesystem structure object from a real directory.
 * Returns { filesystem, permissions } where:
 *   - filesystem is the nested content tree (directories as objects, files as strings or BinaryFiles/SymlinkRefs)
 *   - permissions maps virtual absolute paths to Unix mode bits (e.g. { '/bin/script.sh': 0o755 })
 *
 * Real filenames and extensions (.js, .wasm, etc.) are preserved verbatim.
 * OS symlinks are serialized as SymlinkRef instances.
 * Files are checked for UTF-8/ASCII text content; anything that is not valid text defaults to binary.
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
            const filePath = path.join(root, handle);
            const stat = fs.lstatSync(filePath);

            if(stat.isSymbolicLink()) {
                const target = fs.readlinkSync(filePath);
                structure[handle] = new SymlinkRef(target);
                permissions[virtualPrefix + '/' + handle] = stat.mode & 0o777;
                return structure;
            }

            if(stat.isDirectory()) {
                structure[handle] = _buildTree(
                    filePath,
                    virtualPrefix + '/' + handle,
                    permissions
                );
                return structure;
            }

            const isJavaScript = handle.endsWith('.js');
            const ext = path.extname(handle).toLowerCase();
            const rawBuf = fs.readFileSync(filePath);
            const isWasmMagic = _isWasmBuffer(rawBuf);
            const isKnownBinary = (ext in BINARY_MIME) || isWasmMagic;

            let fileContents;
            if (isJavaScript) {
                // Preserved as UTF-8 text string (bundled with esbuild later during export)
                fileContents = rawBuf.toString('utf8');
            } else if (isKnownBinary) {
                const mime = BINARY_MIME[ext] || (isWasmMagic ? 'application/wasm' : 'application/octet-stream');
                fileContents = `data:${mime};base64,${rawBuf.toString('base64')}`;
            } else if (isUtf8Text(rawBuf)) {
                fileContents = rawBuf.toString('utf8');
            } else {
                // Content-based binary fallback for unknown binary formats (.wad, .gguf, ELF, images, etc.)
                const mime = 'application/octet-stream';
                fileContents = `data:${mime};base64,${rawBuf.toString('base64')}`;
            }

            structure[handle] = fileContents;

            // Record real Unix permission bits for this file
            permissions[virtualPrefix + '/' + handle] = stat.mode & 0o777;
        } catch(fe) {
            // Silently skip files/dirs that are inaccessible
        }
        return structure;
    }, {});
}

module.exports = { buildStructure, IGNORE, BINARY_MIME, _isWasmBuffer };

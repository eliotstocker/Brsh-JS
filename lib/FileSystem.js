'use strict';

const BaseFileSystem = require('./BaseFileSystem');
const { BinaryFile, SymlinkRef } = BaseFileSystem;

/**
 * Recursively converts `data:<mime>;base64,<...>` strings in a filesystem
 * node to BinaryFile instances (Uint8Array subclass), saving the ~33%
 * memory overhead of storing base64-encoded binary data as UTF-16 strings.
 * Mutates the node in-place.
 */
function decodeBinaryFiles(node) {
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof SymlinkRef)) {
            decodeBinaryFiles(value);
        } else if (typeof value === 'string' && value.startsWith('data:')) {
            const semicolon = value.indexOf(';');
            const comma = value.indexOf(',', semicolon);
            if (semicolon !== -1 && comma !== -1 && value.slice(semicolon + 1, comma) === 'base64') {
                const mimeType = value.slice(5, semicolon);
                const b64 = value.slice(comma + 1);
                let bytes;
                if (typeof Buffer !== 'undefined') {
                    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
                } else {
                    const binary = atob(b64);
                    bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                }
                node[key] = new BinaryFile(bytes.buffer, mimeType);
            }
        }
    }
}

class FileSystem extends BaseFileSystem {
    constructor(cwd = '/', filesystem = {}, permissions = {}, onChange = null) {
        super();
        if (filesystem instanceof Uint8Array || filesystem instanceof ArrayBuffer) {
            const { deserializeBinaryFilesystem } = require('./BinaryContainer');
            const decoded = deserializeBinaryFilesystem(filesystem);
            filesystem = decoded.filesystem;
            permissions = Object.assign({}, decoded.permissions, permissions);
        } else if (filesystem && typeof filesystem === 'object' && filesystem.filesystem && (filesystem.filesystem instanceof Uint8Array || typeof filesystem.filesystem === 'object')) {
            permissions = Object.assign({}, filesystem.permissions || {}, permissions);
            filesystem = filesystem.filesystem;
            if (filesystem instanceof Uint8Array || filesystem instanceof ArrayBuffer) {
                const { deserializeBinaryFilesystem } = require('./BinaryContainer');
                const decoded = deserializeBinaryFilesystem(filesystem);
                filesystem = decoded.filesystem;
                permissions = Object.assign({}, decoded.permissions, permissions);
            }
        }
        decodeBinaryFiles(filesystem);
        this.fileSystem = filesystem;
        this.permissions = Object.assign({}, permissions);
        this.cwd = cwd;
        this._onChange = onChange;
        this._changeScheduled = false;
    }

    /**
     * Exports the current virtual filesystem and permissions to a compact BRFS binary container (`Uint8Array`).
     */
    toBinaryContainer(options = {}) {
        const { serializeBinaryFilesystem } = require('./BinaryContainer');
        return serializeBinaryFilesystem(this.fileSystem, this.permissions, options);
    }

    /**
     * Deserializes a BRFS binary container (`Uint8Array` or `ArrayBuffer`) into `{ filesystem, permissions }`.
     */
    static fromBinaryContainer(bytes, customCommandMap = {}) {
        const { deserializeBinaryFilesystem } = require('./BinaryContainer');
        return deserializeBinaryFilesystem(bytes, customCommandMap);
    }

    // Returns file content if the path exists AND is readable; null otherwise.
    // Follows symlinks transparently. Use exists() or stat() for permission-free checks.
    getFileByPath(path) {
        const file = this._resolveByAbsolutePath(this._pathToAbsolute(path), true);
        if (file === null || file === undefined) return null;
        if (!this.isReadable(path)) return null;
        return file;
    }

    // Raw read bypassing permission checks — for internal/system use only.
    _getFileRaw(path) {
        return this._getFileByAbsolutePath(this._pathToAbsolute(path));
    }

    // Returns true if the path exists (and for symlinks, the target resolves too).
    exists(path) {
        const file = this._resolveByAbsolutePath(this._pathToAbsolute(path), true);
        return file !== null && file !== undefined;
    }

    isSymlink(path) {
        const file = this._resolveByAbsolutePath(this._pathToAbsolute(path), false);
        return file instanceof SymlinkRef;
    }
    readSymlink(path) {
        const file = this._resolveByAbsolutePath(this._pathToAbsolute(path), false);
        return file instanceof SymlinkRef ? file.target : null;
    }
    createSymlink(target, linkPath) {
        this._setFileRaw(linkPath, new SymlinkRef(target));
    }

    // Returns type metadata without following the final symlink (like lstat).
    // Returns null if the path does not exist.
    stat(path) {
        const file = this._resolveByAbsolutePath(this._pathToAbsolute(path), false);
        if (file === null || file === undefined) return null;
        if (file instanceof SymlinkRef) {
            return { isDirectory: false, isFile: false, isCommand: false, isBinary: false, isSymlink: true };
        }
        return {
            isDirectory: file.constructor === Object,
            isFile: typeof file === 'string' || file instanceof Uint8Array,
            isCommand: typeof file === 'function',
            isBinary: file instanceof Uint8Array,
            isSymlink: false,
        };
    }

    _pathToAbsolute(path) {
        if(path.startsWith('./')) {
            path = path.substring(2);
        }
        if(!path.startsWith('/')) {
            path = this.cwd + path;
        }
        return this._traverseComplexAbsolutePath(path);
    }

    _traverseComplexAbsolutePath(path) {
        const pathParts = path.split('/');

        while(pathParts.includes('..')) {
            const index = pathParts.indexOf('..') - 1;
            pathParts.splice(index, 2);
        }

        return pathParts.join('/');
    }

    absolutePath(path) {
        return this._pathToAbsolute(path);
    }

    // Writes with permission enforcement — throws Error('Permission denied') if not writable.
    // Use _setFileRaw() for internal/system writes that must bypass permission checks.
    setFileByPath(path, content, createDir = false) {
        const absolute = this._pathToAbsolute(path);
        const existing = this._getFileByAbsolutePath(absolute);
        if (existing !== null && existing !== undefined) {
            if (!this.isWritable(path)) throw new Error('Permission denied');
        } else {
            const parentParts = absolute.split('/');
            parentParts.pop();
            const parentAbs = parentParts.join('/') || '/';
            const parentMode = this.getMode(parentAbs);
            if (parentMode !== null && !(parentMode & 0o200)) throw new Error('Permission denied');
        }
        this._setFileByAbsolutePath(absolute, content, createDir);
        this._triggerChange();
    }

    // Raw write bypassing permission checks — for internal/system use only.
    _setFileRaw(path, content, createDir = false) {
        const absolute = this._pathToAbsolute(path);
        this._setFileByAbsolutePath(absolute, content, createDir);
        this._triggerChange();
    }

    _setFileByAbsolutePath(absolute, content, createDir = true) {
        const parts = absolute.split('/');
        parts.shift();
        const filename = parts.pop();

        let dir = this.fileSystem;
        const pathSoFar = [];
        for (const handle of parts) {
            pathSoFar.push(handle);
            if (!Object.prototype.hasOwnProperty.call(dir, handle)) {
                if (!createDir) throw new Error(`${handle}: No such file or directory`);
                dir[handle] = {};
            }
            let next = dir[handle];
            // Follow symlinks to directories in intermediate path components
            if (next instanceof SymlinkRef) {
                const symlinkDir = '/' + pathSoFar.slice(0, -1).join('/');
                const target = next.target.startsWith('/')
                    ? this._traverseComplexAbsolutePath(next.target)
                    : this._traverseComplexAbsolutePath(symlinkDir + '/' + next.target);
                next = this._resolveByAbsolutePath(target, true);
                if (next == null || typeof next !== 'object' || next instanceof SymlinkRef) {
                    throw new Error(`${handle}: Not a directory`);
                }
            }
            dir = next;
        }
        dir[filename] = content;
    }

    // Resolves a path, optionally following the final symlink component.
    // followLast=true  → like stat()  — follows everything (for reading through symlinks)
    // followLast=false → like lstat() — stops at a final SymlinkRef (for isSymlink/readSymlink/stat)
    // Intermediate symlinks in directory components are always followed.
    // Returns null on a missing path or a symlink loop (depth > 10).
    _resolveByAbsolutePath(absolute, followLast = true, depth = 0) {
        if (depth > 10) return null; // loop protection
        const parts = absolute.split('/');
        parts.shift();
        if (parts.length > 0 && parts[parts.length - 1].length < 1) parts.pop();

        let pointer = this.fileSystem;
        const pathSoFar = [];
        for (let i = 0; i < parts.length; i++) {
            const handle = parts[i];
            const isLast = i === parts.length - 1;
            if (pointer == null || typeof pointer !== 'object' || pointer instanceof SymlinkRef) return null;
            if (!Object.prototype.hasOwnProperty.call(pointer, handle)) return null;
            pointer = pointer[handle];
            pathSoFar.push(handle);
            if (pointer instanceof SymlinkRef && (!isLast || followLast)) {
                const symlinkDir = '/' + pathSoFar.slice(0, -1).join('/');
                const target = pointer.target.startsWith('/')
                    ? this._traverseComplexAbsolutePath(pointer.target)
                    : this._traverseComplexAbsolutePath(symlinkDir + '/' + pointer.target);
                pointer = this._resolveByAbsolutePath(target, true, depth + 1);
                if (pointer == null) return null;
            }
        }
        return pointer;
    }

    _getFileByAbsolutePath(absolute) {
        const parts = absolute.split('/');
        parts.shift();

        if(parts[parts.length - 1].length < 1) {
            parts.pop();
        }

        return parts.reduce((pointer, handle) => {
            if (pointer == null || typeof pointer !== 'object') return null;
            if (!Object.prototype.hasOwnProperty.call(pointer, handle)) return null;
            return pointer[handle];
        }, this.fileSystem);
    }

    deleteFileByPath(path) {
        const absolute = this._pathToAbsolute(path);
        // Deleting requires write permission on the parent directory.
        const parentParts = absolute.split('/');
        parentParts.pop();
        const parentAbs = parentParts.join('/') || '/';
        const parentMode = this.getMode(parentAbs);
        if (parentMode !== null && !(parentMode & 0o200)) {
            throw new Error(`${path}: Permission denied`);
        }
        this._deleteByAbsolutePath(absolute);
        // Remove any explicit permissions for this path and children
        const prefix = absolute + '/';
        Object.keys(this.permissions).forEach(k => {
            if (k === absolute || k.startsWith(prefix)) {
                delete this.permissions[k];
            }
        });
        this._triggerChange();
    }

    _deleteByAbsolutePath(absolute) {
        const parts = absolute.split('/');
        parts.shift();
        if (parts[parts.length - 1] === '') parts.pop();

        const filename = parts.pop();
        if (!filename) return;

        let parent = this.fileSystem;
        const pathSoFar = [];
        for (const handle of parts) {
            pathSoFar.push(handle);
            if (!Object.prototype.hasOwnProperty.call(parent, handle)) return;
            let next = parent[handle];
            if (next instanceof SymlinkRef) {
                const symlinkDir = '/' + pathSoFar.slice(0, -1).join('/');
                const target = next.target.startsWith('/')
                    ? this._traverseComplexAbsolutePath(next.target)
                    : this._traverseComplexAbsolutePath(symlinkDir + '/' + next.target);
                next = this._resolveByAbsolutePath(target, true);
                if (next == null || typeof next !== 'object' || next instanceof SymlinkRef) return;
            }
            parent = next;
        }

        if (parent && filename in parent) {
            delete parent[filename];
        }
    }

    getMode(path) {
        const absolute = this._pathToAbsolute(path);
        if (this.permissions[absolute] !== undefined) {
            return this.permissions[absolute];
        }
        const file = this._resolveByAbsolutePath(absolute, true);
        if (file === null || file === undefined) return null;
        if (file.constructor === Object) return 0o755;
        if (typeof file === 'function') return 0o555;
        return 0o644;
    }

    setMode(path, mode) {
        const absolute = this._pathToAbsolute(path);
        this.permissions[absolute] = mode;
        this._triggerChange();
    }

    getSize(path) {
        const absolute = this._pathToAbsolute(path);
        const file = this._resolveByAbsolutePath(absolute, true);
        if (file === null || file === undefined) return 0;
        if (file.constructor === Object) return JSON.stringify(file).length;
        if (file instanceof Uint8Array) return file.length;
        return file.toString().length;
    }

    getRawPermissions() {
        return Object.assign({}, this.permissions);
    }

    setCwd(cwd) {
        this.cwd = this._pathToAbsolute(cwd.endsWith('/') ? cwd : (cwd + '/'));
    }

    getRaw() {
        return this.fileSystem;
    }

    addFiles(commands) {
        Object.entries(commands).forEach(([path, command]) => {
            this._setFileRaw(path, command, true);
        });
    }

    autoComplete(initial, path) {
        const absolute = this._pathToAbsolute(initial);

        const parts = absolute.split('/');
        const end = parts.pop();

        const dir = this._getFileRaw(parts.length > 1 ? parts.join('/') : '/');
        const pathDir = this._getFileRaw(path);

        if(dir && dir.constructor === Object) {
            let options = Object.keys(dir).filter(item => item.startsWith(end));
            if(end.length < 1) {
                options = options.filter(item => !item.startsWith('.'));
            }

            const initialParts = initial.split('/');
            initialParts.pop();

            let sourceDir = dir;
            if(options.length < 1 && initialParts.length < 1 && pathDir) {
                options = Object.keys(pathDir).filter(item => item.startsWith(end));
                sourceDir = pathDir;
            }

            if(options.length) {
                return {
                    path: initialParts.length ? initialParts.join('/') : null,
                    options: options.map(item => sourceDir[item] && sourceDir[item].constructor === Object ? item.concat('/') : item)
                };
            }
        }
        return null;
    }

}


module.exports = FileSystem;
module.exports.BinaryFile = BinaryFile;
module.exports.SymlinkRef = SymlinkRef;

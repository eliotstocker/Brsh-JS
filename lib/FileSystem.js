'use strict';

const BaseFileSystem = require('./BaseFileSystem');

class FileSystem extends BaseFileSystem {
    constructor(cwd = '/', filesystem = {}, permissions = {}, onChange = null) {
        super();
        this.fileSystem = filesystem;
        this.permissions = Object.assign({}, permissions);
        this.cwd = cwd;
        this._onChange = onChange;
        this._changeScheduled = false;
    }

    // Returns file content if the path exists AND is readable; null otherwise.
    // Use exists() or stat() for permission-free existence/type checks.
    getFileByPath(path) {
        const file = this._getFileByAbsolutePath(this._pathToAbsolute(path));
        if (file === null || file === undefined) return null;
        if (!this.isReadable(path)) return null;
        return file;
    }

    // Raw read bypassing permission checks — for internal/system use only.
    _getFileRaw(path) {
        return this._getFileByAbsolutePath(this._pathToAbsolute(path));
    }

    // Returns true if the path exists regardless of permissions.
    exists(path) {
        const file = this._getFileByAbsolutePath(this._pathToAbsolute(path));
        return file !== null && file !== undefined;
    }

    // Returns type metadata without content access or permission checks.
    // Returns null if the path does not exist.
    stat(path) {
        const file = this._getFileByAbsolutePath(this._pathToAbsolute(path));
        if (file === null || file === undefined) return null;
        return {
            isDirectory: file.constructor === Object,
            isFile: typeof file === 'string',
            isCommand: typeof file === 'function'
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

        const dir = parts.reduce((pointer, handle) => {
            if(!pointer[handle]) {
                if(!createDir) {
                    throw new Error(`${handle}: No such file or directory`)
                }
                pointer[handle] = {};
            }
            return pointer[handle];
        }, this.fileSystem);

        dir[filename] = content;
    }

    _getFileByAbsolutePath(absolute) {
        const parts = absolute.split('/');
        parts.shift();

        if(parts[parts.length - 1].length < 1) {
            parts.pop();
        }

        return parts.reduce((pointer, handle) => {
            if(pointer && pointer[handle]) {
                return pointer[handle];
            }
            return null;
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

        const parent = parts.reduce((pointer, handle) => {
            if (pointer && pointer[handle]) return pointer[handle];
            return null;
        }, this.fileSystem);

        if (parent && filename in parent) {
            delete parent[filename];
        }
    }

    getMode(path) {
        const absolute = this._pathToAbsolute(path);
        if (this.permissions[absolute] !== undefined) {
            return this.permissions[absolute];
        }
        const file = this._getFileByAbsolutePath(absolute);
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
        const file = this._getFileByAbsolutePath(absolute);
        if (file === null || file === undefined) return 0;
        if (file.constructor === Object) return JSON.stringify(file).length;
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

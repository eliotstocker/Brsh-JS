'use strict';

class FileSystem {
    constructor(cwd = '/', filesystem = {}, permissions = {}, onChange = null) {
        this.fileSystem = filesystem;
        this.permissions = Object.assign({}, permissions);
        this.cwd = cwd;
        this._onChange = onChange;
        this._changeScheduled = false;
    }

    getFileByPath(path) {
        return this._getFileByAbsolutePath(this._pathToAbsolute(path));
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

    setFileByPath(path, content, createDir = false) {
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
        if (typeof file === 'function') return 0o755;
        return 0o644;
    }

    setMode(path, mode) {
        const absolute = this._pathToAbsolute(path);
        this.permissions[absolute] = mode;
        this._triggerChange();
    }

    isExecutable(path) {
        const mode = this.getMode(path);
        if (mode === null) return false;
        return (mode & 0o100) !== 0;
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

    getRawPermissions() {
        return Object.assign({}, this.permissions);
    }

    addFiles(commands) {
        Object.entries(commands).forEach(([path, command]) => {
            this.setFileByPath(path, command, true);
        });
    }

    autoComplete(initial, path) {
        const absolute = this._pathToAbsolute(initial);

        const parts = absolute.split('/');
        const end = parts.pop();

        const dir = this.getFileByPath(parts.length > 1 ? parts.join('/') : '/');
        const pathDir = this.getFileByPath(path);

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

    // Schedules a single onChange notification per microtask tick,
    // so multiple mutations in one command emit only one callback.
    _triggerChange() {
        if (!this._onChange || this._changeScheduled) return;
        this._changeScheduled = true;
        Promise.resolve().then(() => {
            this._changeScheduled = false;
            if (typeof this._onChange === 'function') {
                this._onChange(this.getRaw(), this.getRawPermissions());
            }
        });
    }
}

module.exports = FileSystem;

'use strict';

class FileSystem {
    constructor(cwd = '/', filesystem = {}) {
        this.fileSystem = filesystem;
        this.cwd = cwd;
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

    setFileByPath(path, content, createDir = false) {
        const absolute = this._pathToAbsolute(path);

        this._setFileByAbsolutePath(absolute, content, createDir);
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

    setCwd(cwd) {
        this.cwd = this._pathToAbsolute(cwd.endsWith('/') ? cwd : (cwd + '/'));
    }

    getRaw() {
        return this.fileSystem;
    }

    addFiles(commands) {
        Object.entries(commands).forEach(([path, command]) => {
            this.setFileByPath(path, command, true);
        });
    }
}

module.exports = FileSystem;
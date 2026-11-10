'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const BaseFileSystem = require('./BaseFileSystem');

class NodeFileSystem extends BaseFileSystem {
    constructor(cwd, onChange = null) {
        super();
        this._onChange = onChange;
        this._changeScheduled = false;
        this._virtualFiles = {};
        this.cwd = this._normalizeCwd(cwd || process.cwd());
    }

    get isRealFilesystem() { return true; }

    _normalizeCwd(cwd) {
        const abs = nodePath.resolve(cwd);
        return abs === '/' ? '/' : abs + '/';
    }

    absolutePath(path) {
        if (path.startsWith('./')) path = path.slice(2);
        const abs = path.startsWith('/') ? path : nodePath.join(this.cwd, path);
        return nodePath.normalize(abs);
    }

    setCwd(cwd) {
        const trimmed = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
        const abs = this.absolutePath(trimmed);
        this.cwd = abs === '/' ? '/' : abs + '/';
    }

    getFileByPath(path) {
        const abs = this.absolutePath(path);

        if (this._virtualFiles[abs] !== undefined) {
            return this._virtualFiles[abs];
        }

        let stat;
        try {
            stat = nodeFs.statSync(abs);
        } catch(e) {
            return null;
        }

        if (stat.isDirectory()) {
            const entries = {};
            try {
                for (const name of nodeFs.readdirSync(abs)) {
                    const childAbs = nodePath.join(abs, name);
                    if (this._virtualFiles[childAbs] !== undefined) {
                        entries[name] = this._virtualFiles[childAbs];
                    } else {
                        try {
                            entries[name] = nodeFs.statSync(childAbs).isDirectory() ? {} : '';
                        } catch(e) { /* skip unreadable */ }
                    }
                }
            } catch(e) { /* directory unreadable */ }

            // Virtual files in this directory not shadowed by real entries
            const prefix = abs === '/' ? '/' : abs + '/';
            for (const vPath of Object.keys(this._virtualFiles)) {
                if (vPath.startsWith(prefix) && !vPath.slice(prefix.length).includes('/')) {
                    const name = vPath.slice(prefix.length);
                    if (!(name in entries)) entries[name] = this._virtualFiles[vPath];
                }
            }

            return entries;
        }

        try {
            return nodeFs.readFileSync(abs, 'utf8');
        } catch(e) {
            return null;
        }
    }

    setFileByPath(path, content, createDir = false) {
        const abs = this.absolutePath(path);

        if (typeof content === 'function' || content instanceof Uint8Array) {
            this._virtualFiles[abs] = content;
            return;
        }

        if (content !== null && content !== undefined && content.constructor === Object) {
            try {
                nodeFs.mkdirSync(abs, { recursive: createDir });
                this._triggerChange();
            } catch (e) {
                this._virtualFiles[abs] = content;
            }
            return;
        }

        try {
            if (createDir) {
                nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
            }
            nodeFs.writeFileSync(abs, String(content));
            this._triggerChange();
        } catch (e) {
            this._virtualFiles[abs] = String(content);
        }
    }

    deleteFileByPath(path) {
        const abs = this.absolutePath(path);
        delete this._virtualFiles[abs];
        try {
            const stat = nodeFs.lstatSync(abs);
            if (stat.isDirectory()) {
                nodeFs.rmdirSync(abs);
            } else {
                nodeFs.unlinkSync(abs);
            }
            this._triggerChange();
        } catch(e) { /* may not exist on real fs */ }
    }

    getMode(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            return typeof this._virtualFiles[abs] === 'function' ? 0o755 : 0o644;
        }
        try {
            return nodeFs.statSync(abs).mode & 0o777;
        } catch(e) {
            return null;
        }
    }

    setMode(path, mode) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            return;
        }
        try {
            nodeFs.chmodSync(abs, mode);
            this._triggerChange();
        } catch (e) { /* ignore chmod errors on virtualized paths */ }
    }

    getSize(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) return 0;
        try {
            return nodeFs.statSync(abs).size;
        } catch(e) {
            return 0;
        }
    }

    isSymlink(path) {
        const abs = this.absolutePath(path);
        try { return nodeFs.lstatSync(abs).isSymbolicLink(); } catch(e) { return false; }
    }

    readSymlink(path) {
        const abs = this.absolutePath(path);
        try { return nodeFs.readlinkSync(abs); } catch(e) { return null; }
    }

    createSymlink(target, linkPath) {
        const abs = this.absolutePath(linkPath);
        nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
        nodeFs.symlinkSync(target, abs);
        this._triggerChange();
    }

    getRaw() {
        return null;
    }

    getRawPermissions() {
        return {};
    }

    addFiles(commands) {
        Object.entries(commands).forEach(([path, command]) => {
            this.setFileByPath(path, command, true);
        });
    }

    autoComplete(initial, commandPath) {
        const abs = this.absolutePath(initial);
        const parts = abs.split('/');
        const end = parts.pop();
        const dirPath = parts.join('/') || '/';

        let dirEntries = [];
        try {
            dirEntries = nodeFs.readdirSync(dirPath);
        } catch(e) { /* not readable */ }

        const prefix = dirPath === '/' ? '/' : dirPath + '/';
        for (const vPath of Object.keys(this._virtualFiles)) {
            if (vPath.startsWith(prefix) && !vPath.slice(prefix.length).includes('/')) {
                const name = vPath.slice(prefix.length);
                if (!dirEntries.includes(name)) dirEntries.push(name);
            }
        }

        let options = dirEntries.filter(item => item.startsWith(end));

        if (options.length === 0 && !initial.includes('/')) {
            const pathDir = this.getFileByPath(commandPath);
            if (pathDir && pathDir.constructor === Object) {
                options = Object.keys(pathDir).filter(item => item.startsWith(initial));
                if (options.length) return { path: null, options };
            }
        }

        if (!options.length) return null;

        const initialParts = initial.split('/');
        initialParts.pop();

        return {
            path: initialParts.length ? initialParts.join('/') : null,
            options: options.map(name => {
                const fullPath = nodePath.join(dirPath, name);
                if (this._virtualFiles[fullPath] !== undefined) return name;
                try {
                    return nodeFs.statSync(fullPath).isDirectory() ? name + '/' : name;
                } catch(e) { return name; }
            })
        };
    }

    // System-internal bypass (NodeFileSystem has no permission layer over real FS)
    _getFileRaw(path) {
        return this.getFileByPath(path);
    }

    _setFileRaw(path, content, createDir = false) {
        return this.setFileByPath(path, content, createDir);
    }

    exists(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) return true;
        try { nodeFs.statSync(abs); return true; } catch(e) { return false; }
    }

    loadModule(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            const v = this._virtualFiles[abs];
            if (typeof v === 'function') return v;
            return super.loadModule(path);
        }
        try {
            const mod = require(abs);
            return mod && mod.default !== undefined ? mod.default : mod;
        } catch (err) {
            return super.loadModule(path);
        }
    }

    stat(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            const v = this._virtualFiles[abs];
            return { isDirectory: v !== null && v !== undefined && v.constructor === Object, isFile: typeof v === 'string' || v instanceof Uint8Array, isCommand: typeof v === 'function', isBinary: v instanceof Uint8Array };
        }
        try {
            const s = nodeFs.statSync(abs);
            return { isDirectory: s.isDirectory(), isFile: s.isFile(), isCommand: false };
        } catch(e) { return null; }
    }
}

module.exports = NodeFileSystem;

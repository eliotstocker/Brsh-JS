'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const BaseFileSystem = require('./BaseFileSystem');
const { BinaryFile, SymlinkRef, isUtf8Text } = BaseFileSystem;

class NodeFileSystem extends BaseFileSystem {
    constructor(cwd = '/', onChange = null, options = {}) {
        super();
        this._onChange = onChange;
        this._changeScheduled = false;
        this._virtualFiles = {};
        this._rootDir = options && options.rootDir ? nodePath.resolve(options.rootDir) : null;
        this.cwd = this._normalizeCwd(cwd || (this._rootDir ? '/' : process.cwd()));
    }

    get isRealFilesystem() { return true; }

    get rootDir() { return this._rootDir; }

    _normalizeCwd(cwd) {
        if (this._rootDir) {
            let abs = cwd.startsWith('/') ? cwd : '/' + cwd;
            abs = nodePath.posix.normalize(abs);
            return abs === '/' ? '/' : abs + '/';
        }
        const abs = nodePath.resolve(cwd);
        return abs === '/' ? '/' : abs + '/';
    }

    absolutePath(path) {
        if (!path) return this.cwd;
        if (path.startsWith('./')) path = path.slice(2);
        if (this._rootDir) {
            const abs = path.startsWith('/') ? path : nodePath.posix.join(this.cwd, path);
            return nodePath.posix.normalize(abs);
        }
        const abs = path.startsWith('/') ? path : nodePath.join(this.cwd, path);
        return nodePath.normalize(abs);
    }

    _toHostPath(virtualPath) {
        const vAbs = this.absolutePath(virtualPath);
        if (!this._rootDir) {
            return nodePath.resolve(vAbs);
        }
        const rel = vAbs.replace(/^\/+/, '');
        const hostPath = nodePath.resolve(this._rootDir, rel);
        if (hostPath !== this._rootDir && !hostPath.startsWith(this._rootDir + nodePath.sep)) {
            return this._rootDir;
        }
        return hostPath;
    }

    _resolveVirtualPath(virtualPath, maxHops = 10) {
        let current = this.absolutePath(virtualPath);
        let hops = 0;
        while (hops++ < maxHops) {
            const host = this._toHostPath(current);
            let isLink = false;
            let target = null;
            try {
                if (nodeFs.lstatSync(host).isSymbolicLink()) {
                    isLink = true;
                    target = nodeFs.readlinkSync(host);
                }
            } catch (_) {}
            if (!isLink || !target) break;
            if (target.startsWith('/')) {
                current = this.absolutePath(target);
            } else {
                current = this.absolutePath(nodePath.posix.join(nodePath.posix.dirname(current), target));
            }
        }
        return current;
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

        const resolvedVirtual = this._resolveVirtualPath(abs);
        const hostPath = this._toHostPath(resolvedVirtual);

        let stat;
        try {
            stat = nodeFs.statSync(hostPath);
        } catch(e) {
            return null;
        }

        if (stat.isDirectory()) {
            const entries = {};
            try {
                for (const name of nodeFs.readdirSync(hostPath)) {
                    const childAbs = this.absolutePath(nodePath.posix.join(resolvedVirtual, name));
                    if (this._virtualFiles[childAbs] !== undefined) {
                        entries[name] = this._virtualFiles[childAbs];
                    } else {
                        try {
                            const childHost = nodePath.join(hostPath, name);
                            const childStat = nodeFs.statSync(childHost);
                            entries[name] = childStat.isDirectory() ? {} : '';
                        } catch(e) {
                            // If child is a symlink or unreadable file
                            try {
                                if (nodeFs.lstatSync(nodePath.join(hostPath, name)).isSymbolicLink()) {
                                    entries[name] = '';
                                }
                            } catch (_) {}
                        }
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
            const buf = nodeFs.readFileSync(hostPath);
            if (isUtf8Text(buf)) {
                return buf.toString('utf8');
            }
            return new BinaryFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        } catch(e) {
            return null;
        }
    }

    setFileByPath(path, content, createDir = false) {
        const abs = this.absolutePath(path);

        if (typeof content === 'function') {
            this._virtualFiles[abs] = content;
            return;
        }

        const hostPath = this._toHostPath(abs);

        if (content instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(content))) {
            const u8 = content instanceof Uint8Array
                ? Buffer.from(content.buffer, content.byteOffset, content.byteLength)
                : content;
            try {
                if (createDir) {
                    nodeFs.mkdirSync(nodePath.dirname(hostPath), { recursive: true });
                }
                nodeFs.writeFileSync(hostPath, u8);
                delete this._virtualFiles[abs];
                this._triggerChange();
            } catch (e) {
                this._virtualFiles[abs] = content;
            }
            return;
        }

        if (content !== null && content !== undefined && content.constructor === Object) {
            try {
                nodeFs.mkdirSync(hostPath, { recursive: createDir });
                delete this._virtualFiles[abs];
                this._triggerChange();
            } catch (e) {
                this._virtualFiles[abs] = content;
            }
            return;
        }

        try {
            if (createDir) {
                nodeFs.mkdirSync(nodePath.dirname(hostPath), { recursive: true });
            }
            nodeFs.writeFileSync(hostPath, String(content));
            delete this._virtualFiles[abs];
            this._triggerChange();
        } catch (e) {
            this._virtualFiles[abs] = String(content);
        }
    }

    deleteFileByPath(path) {
        const abs = this.absolutePath(path);
        delete this._virtualFiles[abs];
        const hostPath = this._toHostPath(abs);
        try {
            const stat = nodeFs.lstatSync(hostPath);
            if (stat.isDirectory()) {
                nodeFs.rmSync(hostPath, { recursive: true, force: true });
            } else {
                nodeFs.unlinkSync(hostPath);
            }
            this._triggerChange();
        } catch(e) { /* may not exist on real fs */ }
    }

    getMode(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            return typeof this._virtualFiles[abs] === 'function' ? 0o755 : 0o644;
        }
        const hostPath = this._toHostPath(abs);
        try {
            return nodeFs.lstatSync(hostPath).mode & 0o777;
        } catch(e) {
            return null;
        }
    }

    setMode(path, mode) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            return;
        }
        const hostPath = this._toHostPath(abs);
        try {
            if (nodeFs.lstatSync(hostPath).isSymbolicLink()) {
                return;
            }
            nodeFs.chmodSync(hostPath, mode);
            this._triggerChange();
        } catch (e) { /* ignore chmod errors */ }
    }

    getSize(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) return 0;
        const resolvedVirtual = this._resolveVirtualPath(abs);
        const hostPath = this._toHostPath(resolvedVirtual);
        try {
            return nodeFs.statSync(hostPath).size;
        } catch(e) {
            return 0;
        }
    }

    isSymlink(path) {
        const abs = this.absolutePath(path);
        const hostPath = this._toHostPath(abs);
        try { return nodeFs.lstatSync(hostPath).isSymbolicLink(); } catch(e) { return false; }
    }

    readSymlink(path) {
        const abs = this.absolutePath(path);
        const hostPath = this._toHostPath(abs);
        try { return nodeFs.readlinkSync(hostPath); } catch(e) { return null; }
    }

    createSymlink(target, linkPath) {
        const abs = this.absolutePath(linkPath);
        const hostPath = this._toHostPath(abs);
        nodeFs.mkdirSync(nodePath.dirname(hostPath), { recursive: true });
        try {
            nodeFs.unlinkSync(hostPath);
        } catch (_) {}
        nodeFs.symlinkSync(target, hostPath);
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
        const hostDirPath = this._toHostPath(dirPath);

        let dirEntries = [];
        try {
            dirEntries = nodeFs.readdirSync(hostDirPath);
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
                const fullVirtual = nodePath.posix.join(dirPath, name);
                if (this._virtualFiles[fullVirtual] !== undefined) return name;
                try {
                    const fullHost = this._toHostPath(fullVirtual);
                    return nodeFs.statSync(fullHost).isDirectory() ? name + '/' : name;
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
        const hostPath = this._toHostPath(abs);
        try {
            if (nodeFs.lstatSync(hostPath).isSymbolicLink()) {
                const resolvedVirtual = this._resolveVirtualPath(abs);
                const resolvedHost = this._toHostPath(resolvedVirtual);
                return nodeFs.existsSync(resolvedHost);
            }
            return nodeFs.existsSync(hostPath);
        } catch(e) { return false; }
    }

    loadModule(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            const v = this._virtualFiles[abs];
            if (typeof v === 'function') return v;
            return super.loadModule(path);
        }
        const hostPath = this._toHostPath(abs);
        try {
            const mod = require(hostPath);
            return mod && mod.default !== undefined ? mod.default : mod;
        } catch (err) {
            return super.loadModule(path);
        }
    }

    stat(path) {
        const abs = this.absolutePath(path);
        if (this._virtualFiles[abs] !== undefined) {
            const v = this._virtualFiles[abs];
            return {
                isDirectory: v !== null && v !== undefined && v.constructor === Object,
                isFile: typeof v === 'string' || v instanceof Uint8Array,
                isCommand: typeof v === 'function',
                isBinary: v instanceof Uint8Array
            };
        }
        const resolvedVirtual = this._resolveVirtualPath(abs);
        const hostPath = this._toHostPath(resolvedVirtual);
        try {
            const s = nodeFs.statSync(hostPath);
            return { isDirectory: s.isDirectory(), isFile: s.isFile(), isCommand: false };
        } catch(e) { return null; }
    }
}

module.exports = NodeFileSystem;

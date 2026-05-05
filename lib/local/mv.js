'use strict';

const LocalCommand = require('./LocalCommand');
const nodeFs = require('fs');

class Mv extends LocalCommand {
    get name() { return 'mv'; }
    get requiresFilesystem() { return true; }

    run() {
        let destFirst = null;
        const rawPaths = [];

        const args = [...this.arguments];
        let i = 0;
        while (i < args.length) {
            const arg = args[i];
            if (arg === '--') { i++; break; }
            if (arg.startsWith('-') && arg.length > 1) {
                for (let j = 1; j < arg.length; j++) {
                    switch (arg[j]) {
                        case 'f': case 'i': case 'n': break;
                        case 't': {
                            const rest = arg.slice(j + 1);
                            destFirst = rest.length > 0 ? rest : args[++i];
                            j = arg.length;
                            break;
                        }
                    }
                }
            } else {
                rawPaths.push(arg);
            }
            i++;
        }
        while (i < args.length) rawPaths.push(args[i++]);

        const dest = destFirst !== null ? destFirst : rawPaths[rawPaths.length - 1];
        const sources = destFirst !== null ? rawPaths : rawPaths.slice(0, -1);

        if (!dest || sources.length === 0) {
            this.stdErr = `mv: missing destination file operand${sources.length ? ` after '${sources[0]}'` : ''}`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        const destEntry = this.fs.getFileByPath(dest);
        const destIsDir = destEntry !== null && destEntry !== undefined && destEntry.constructor === Object;

        for (const src of sources) {
            const targetPath = destIsDir
                ? dest.replace(/\/$/, '') + '/' + src.split('/').pop()
                : dest;

            if (this.fs.isRealFilesystem) {
                const srcAbs = this.fs.absolutePath(src);
                const destAbs = this.fs.absolutePath(targetPath);
                // lstatSync works for unreadable files and dangling symlinks;
                // getFileByPath would return null for both, masking existence.
                try { nodeFs.lstatSync(srcAbs); } catch {
                    this.stdErr = `mv: cannot stat '${src}': No such file or directory`;
                    this.exitCode = 1;
                    continue;
                }
                try {
                    const nodePath = require('path');
                    nodeFs.mkdirSync(nodePath.dirname(destAbs), { recursive: true });
                    nodeFs.renameSync(srcAbs, destAbs);
                } catch(e) {
                    this.stdErr = `mv: cannot move '${src}' to '${targetPath}': ${e.message}`;
                    this.exitCode = 1;
                }
            } else {
                const srcEntry = this.fs.getFileByPath(src);
                if (srcEntry === null || srcEntry === undefined) {
                    this.stdErr = `mv: cannot stat '${src}': No such file or directory`;
                    this.exitCode = 1;
                    continue;
                }
                this.fs.setFileByPath(targetPath, this._deepCopy(srcEntry), true);
                this.fs.deleteFileByPath(src);
            }
        }
        return Promise.resolve();
    }

    _deepCopy(content) {
        if (content === null || content === undefined) return content;
        if (typeof content === 'function' || typeof content !== 'object') return content;
        const copy = {};
        for (const [k, v] of Object.entries(content)) copy[k] = this._deepCopy(v);
        return copy;
    }
}

module.exports = Mv;

'use strict';

const LocalCommand = require('./LocalCommand');
const nodeFs = require('fs');

class Rm extends LocalCommand {
    get name() { return 'rm'; }
    get requiresFilesystem() { return true; }

    run() {
        let recursive = false;
        let force = false;
        const paths = [];

        for (const arg of this.arguments) {
            if (/^-[rRf]+$/.test(arg)) {
                if (arg.includes('r') || arg.includes('R')) recursive = true;
                if (arg.includes('f')) force = true;
            } else {
                paths.push(arg);
            }
        }

        if (paths.length === 0) {
            if (!force) {
                this.stdErr = 'rm: missing operand';
                this.exitCode = 1;
            }
            return Promise.resolve();
        }

        for (const path of paths) {
            try {
                this._remove(path, recursive, force);
            } catch(e) {
                this.stdErr = e.message;
                this.exitCode = 1;
            }
        }
        return Promise.resolve();
    }

    _remove(path, recursive, force) {
        const isLink = this.fs.isSymlink ? this.fs.isSymlink(path) : false;
        if (!isLink) {
            const file = this.fs.getFileByPath(path);
            if (file === null || file === undefined) {
                if (!force) throw new Error(`rm: cannot remove '${path}': No such file or directory`);
                return;
            }
            if (file.constructor === Object) {
                if (!recursive) throw new Error(`rm: cannot remove '${path}': Is a directory`);
                // Use readdirSync on real fs to catch all entries including dangling symlinks,
                // which getFileByPath skips because statSync throws for them.
                let children;
                if (this.fs.isRealFilesystem) {
                    try { children = nodeFs.readdirSync(this.fs.absolutePath(path)); } catch(e) { children = []; }
                } else {
                    children = Object.keys(file);
                }
                for (const key of children) {
                    const childPath = path.replace(/\/$/, '') + '/' + key;
                    this._remove(childPath, recursive, force);
                }
            }
        }
        this.fs.deleteFileByPath(path);
    }
}

module.exports = Rm;

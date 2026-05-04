'use strict';

const LocalCommand = require('./LocalCommand');

class Cp extends LocalCommand {
    get name() { return 'cp'; }
    get requiresFilesystem() { return true; }

    run() {
        let recursive = false;
        const paths = [];

        for (const arg of this.arguments) {
            if (/^-[rRf]+$/.test(arg)) {
                if (arg.includes('r') || arg.includes('R')) recursive = true;
            } else {
                paths.push(arg);
            }
        }

        if (paths.length < 2) {
            this.stdErr = `cp: missing destination file operand${paths.length ? ` after '${paths[0]}'` : ''}`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        const dest = paths[paths.length - 1];
        const sources = paths.slice(0, -1);
        const destFile = this.fs.getFileByPath(dest);
        const destIsDir = destFile !== null && destFile !== undefined && destFile.constructor === Object;

        for (const src of sources) {
            const srcContent = this.fs.getFileByPath(src);
            if (srcContent === null || srcContent === undefined) {
                this.stdErr = `cp: cannot stat '${src}': No such file or directory`;
                this.exitCode = 1;
                continue;
            }
            if (srcContent.constructor === Object && !recursive) {
                this.stdErr = `cp: -r not specified; omitting directory '${src}'`;
                this.exitCode = 1;
                continue;
            }

            const targetPath = destIsDir
                ? dest.replace(/\/$/, '') + '/' + src.split('/').pop()
                : dest;

            this._copy(srcContent, targetPath);
        }
        return Promise.resolve();
    }

    _copy(content, dest) {
        if (content && content.constructor === Object) {
            this.fs.setFileByPath(dest, {}, true);
            for (const [name, child] of Object.entries(content)) {
                this._copy(child, dest.replace(/\/$/, '') + '/' + name);
            }
        } else {
            this.fs.setFileByPath(dest, content, true);
        }
    }
}

module.exports = Cp;

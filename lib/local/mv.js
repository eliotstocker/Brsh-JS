'use strict';

const LocalCommand = require('./LocalCommand');

class Mv extends LocalCommand {
    get name() { return 'mv'; }
    get requiresFilesystem() { return true; }

    run() {
        const paths = this.arguments.filter(a => a !== '-f' && a !== '-i');

        if (paths.length < 2) {
            this.stdErr = `mv: missing destination file operand${paths.length ? ` after '${paths[0]}'` : ''}`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        const dest = paths[paths.length - 1];
        const sources = paths.slice(0, -1);
        const destFile = this.fs.getFileByPath(dest);
        const destIsDir = destFile !== null && destFile !== undefined && destFile.constructor === Object;

        for (const src of sources) {
            const srcFile = this.fs.getFileByPath(src);
            if (srcFile === null || srcFile === undefined) {
                this.stdErr = `mv: cannot stat '${src}': No such file or directory`;
                this.exitCode = 1;
                continue;
            }

            const targetPath = destIsDir
                ? dest.replace(/\/$/, '') + '/' + src.split('/').pop()
                : dest;

            this.fs.setFileByPath(targetPath, this._deepCopy(srcFile), true);
            this.fs.deleteFileByPath(src);
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

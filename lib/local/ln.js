'use strict';

const LocalCommand = require('./LocalCommand');
const nodeFs = (() => { try { return require('fs'); } catch { return null; } })();

class Ln extends LocalCommand {
    static get name() { return 'ln'; }
    get requiresFilesystem() { return true; }

    run() {
        let symbolic = false;
        let force = false;
        const paths = [];

        const args = [...this.arguments];
        let i = 0;
        while (i < args.length) {
            const arg = args[i];
            if (arg === '--') { i++; break; }
            if (arg.startsWith('-') && arg.length > 1) {
                for (const ch of arg.slice(1)) {
                    switch (ch) {
                        case 's': symbolic = true; break;
                        case 'f': force = true; break;
                        case 'n': break; // --no-dereference, no-op
                        case 'v': break; // verbose, no-op
                    }
                }
            } else {
                paths.push(arg);
            }
            i++;
        }
        while (i < args.length) paths.push(args[i++]);

        if (paths.length < 2) {
            this.stdErr = paths.length === 0
                ? 'ln: missing file operand'
                : `ln: missing destination file operand after '${paths[0]}'`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        const dest = paths[paths.length - 1];
        const sources = paths.slice(0, -1);
        const destStat = this.fs.stat(dest);
        const destIsDir = destStat !== null && destStat.isDirectory;

        for (const src of sources) {
            const linkPath = destIsDir
                ? dest.replace(/\/$/, '') + '/' + src.split('/').pop()
                : dest;

            // Remove existing target if -f
            if (force && this.fs.exists(linkPath)) {
                const ls = this.fs.stat(linkPath);
                if (!ls?.isDirectory) {
                    try { this.fs.deleteFileByPath(linkPath); } catch(e) { /* ignore */ }
                }
            }

            if (symbolic) {
                if (!this.fs.createSymlink) {
                    this.stdErr = `ln: cannot create symlink '${linkPath}': Operation not supported`;
                    this.exitCode = 1;
                    continue;
                }
                try {
                    this.fs.createSymlink(src, linkPath);
                } catch(e) {
                    this.stdErr = `ln: cannot create symlink '${linkPath}': ${e.message}`;
                    this.exitCode = 1;
                }
            } else {
                // Hard link — only supported on real FS
                if (!this.fs.isRealFilesystem || !nodeFs) {
                    this.stdErr = `ln: cannot create hard link '${linkPath}': Operation not supported`;
                    this.exitCode = 1;
                    continue;
                }
                if (!this.fs.exists(src)) {
                    this.stdErr = `ln: failed to create hard link '${linkPath}' => '${src}': No such file or directory`;
                    this.exitCode = 1;
                    continue;
                }
                try {
                    nodeFs.linkSync(
                        this.fs.absolutePath(src),
                        this.fs.absolutePath(linkPath)
                    );
                } catch(e) {
                    this.stdErr = `ln: failed to create hard link '${linkPath}' => '${src}': ${e.message}`;
                    this.exitCode = 1;
                }
            }
        }
        return Promise.resolve();
    }
}

module.exports = Ln;

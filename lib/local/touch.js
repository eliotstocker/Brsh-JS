'use strict';

const LocalCommand = require('./LocalCommand');
const nodeFs = (() => { try { return require('fs'); } catch { return null; } })();

class Touch extends LocalCommand {
    static get name() { return 'touch'; }
    get requiresFilesystem() { return true; }

    run() {
        let noCreate = false;
        const paths = [];

        for (const arg of this.arguments) {
            if (arg === '--') break;
            if (arg.startsWith('-') && arg.length > 1) {
                for (const ch of arg.slice(1)) {
                    if (ch === 'c') noCreate = true;
                    // -a, -m, -t, -d: timestamp flags — update timestamps but
                    // ignore the specific value (no mtime tracking in virtual FS)
                }
            } else {
                paths.push(arg);
            }
        }

        if (paths.length === 0) {
            this.stdErr = 'touch: missing file operand';
            this.exitCode = 1;
            return Promise.resolve();
        }

        const now = new Date();
        for (const path of paths) {
            if (this.fs.exists(path)) {
                // File exists — update timestamps on real FS; no-op on virtual FS
                if (nodeFs && this.fs.isRealFilesystem) {
                    try {
                        nodeFs.utimesSync(this.fs.absolutePath(path), now, now);
                    } catch(e) {
                        this.stdErr = `touch: cannot touch '${path}': ${e.message}`;
                        this.exitCode = 1;
                    }
                }
            } else {
                if (noCreate) continue;
                try {
                    this.fs.setFileByPath(path, '', true);
                } catch(e) {
                    this.stdErr = `touch: cannot touch '${path}': ${e.message}`;
                    this.exitCode = 1;
                }
            }
        }
        return Promise.resolve();
    }
}

module.exports = Touch;

'use strict';

const LocalCommand = require('./LocalCommand');

class Mkdir extends LocalCommand {
    get name() { return 'mkdir'; }
    get requiresFilesystem() { return true; }

    run() {
        let createParents = false;
        const paths = [];

        for (const arg of this.arguments) {
            if (arg === '-p' || arg === '--parents') createParents = true;
            else paths.push(arg);
        }

        if (paths.length === 0) {
            this.stdErr = 'mkdir: missing operand';
            this.exitCode = 1;
            return Promise.resolve();
        }

        for (const dir of paths) {
            const existing = this.fs.getFileByPath(dir);
            if (existing !== null && existing !== undefined) {
                if (!createParents) {
                    this.stdErr = `mkdir: cannot create directory '${dir}': File exists`;
                    this.exitCode = 1;
                }
                continue;
            }
            try {
                this.fs.setFileByPath(dir, {}, createParents);
            } catch(e) {
                this.stdErr = `mkdir: cannot create directory '${dir}': ${e.message}`;
                this.exitCode = 1;
            }
        }
        return Promise.resolve();
    }
}

module.exports = Mkdir;

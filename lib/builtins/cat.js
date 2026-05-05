'use strict';

const Command = require('../Command');

class Cat extends Command {
    get requiresFilesystem() {
        return true;
    }

    run() {
        let numberLines = false;
        let numberNonBlank = false;
        let squeezeBlank = false;
        const paths = [];

        for (const arg of this.arguments) {
            if (arg.startsWith('-') && arg.length > 1) {
                for (const ch of arg.slice(1)) {
                    if (ch === 'n') numberLines = true;
                    else if (ch === 'b') { numberNonBlank = true; numberLines = false; }
                    else if (ch === 's') squeezeBlank = true;
                }
            } else {
                paths.push(arg);
            }
        }

        const parts = [];

        if (paths.length === 0) {
            const stdinContent = this.stdin;
            if (stdinContent == null) {
                this.stdErr = 'cat: no file specified';
                this.exitCode = 1;
                return Promise.resolve();
            }
            parts.push(stdinContent);
        } else {
            for (const path of paths) {
                if (path === '-') {
                    parts.push(this.stdin || '');
                    continue;
                }
                const file = this.fs.getFileByPath(path);
                if (file === null || file === undefined) {
                    this.stdErr = `${path}: No such file or directory`;
                    this.exitCode = 1;
                    return Promise.resolve();
                }
                if (file.constructor === Object) {
                    this.stdErr = `${path}: Is a directory`;
                    this.exitCode = 1;
                    return Promise.resolve();
                }
                parts.push(file.toString());
            }
        }

        let content = parts.join('');
        // POSIX text files end with \n; strip it before splitting so the trailing
        // empty element doesn't become a spurious blank output line.
        if (content.endsWith('\n')) content = content.slice(0, -1);
        let lines = content.split('\n');

        if (squeezeBlank) {
            lines = lines.reduce((acc, line) => {
                if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') return acc;
                acc.push(line);
                return acc;
            }, []);
        }

        if (numberNonBlank || numberLines) {
            let n = 0;
            lines = lines.map(line => {
                if (numberNonBlank && line === '') return line;
                n++;
                return `${String(n).padStart(6)}\t${line}`;
            });
        }

        lines.forEach(line => this.stdOut = line);
        return Promise.resolve();
    }
}

module.exports = Cat;

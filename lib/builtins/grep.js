'use strict';

const Command = require('../Command');

class Grep extends Command {
    get requiresFilesystem() { return true; }

    run() {
        let ignoreCase = false;
        let invertMatch = false;
        let lineNumbers = false;
        let countOnly = false;
        let listFiles = false;
        let quiet = false;
        let recursive = false;
        let fixedString = false;
        let pattern = null;
        const paths = [];

        const args = [...this.arguments];
        let i = 0;

        while (i < args.length) {
            const arg = args[i];
            if (arg === '--') { i++; break; }

            if (arg.startsWith('-') && arg.length > 1) {
                const flags = arg.slice(1);
                let skip = false;
                for (let j = 0; j < flags.length && !skip; j++) {
                    switch (flags[j]) {
                        case 'i': ignoreCase = true; break;
                        case 'v': invertMatch = true; break;
                        case 'n': lineNumbers = true; break;
                        case 'c': countOnly = true; break;
                        case 'l': listFiles = true; break;
                        case 'q': quiet = true; break;
                        case 'r': case 'R': recursive = true; break;
                        case 'F': fixedString = true; break;
                        case 'E': break; // extended regex — default behaviour already
                        case 'e':
                            pattern = flags.slice(j + 1) || args[++i];
                            skip = true;
                            break;
                        default:
                            this.stdErr = `grep: invalid option -- '${flags[j]}'`;
                            this.exitCode = 2;
                            return Promise.resolve();
                    }
                }
            } else {
                paths.push(arg);
            }
            i++;
        }
        while (i < args.length) paths.push(args[i++]);

        if (pattern === null) {
            if (paths.length === 0) {
                this.stdErr = 'grep: no pattern given';
                this.exitCode = 2;
                return Promise.resolve();
            }
            pattern = paths.shift();
        }

        if (paths.length === 0) {
            this.stdErr = 'grep: no files given';
            this.exitCode = 2;
            return Promise.resolve();
        }

        // Build the regex
        let regex;
        try {
            const escapedPattern = fixedString
                ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                : pattern;
            regex = new RegExp(escapedPattern, ignoreCase ? 'i' : '');
        } catch(e) {
            this.stdErr = `grep: invalid regex: ${e.message}`;
            this.exitCode = 2;
            return Promise.resolve();
        }

        // Collect all (filePath, content) pairs to search
        const files = [];
        let hasError = false;

        const collectFiles = (p) => {
            const entry = this.fs.getFileByPath(p);
            if (entry === null || entry === undefined) {
                this.stdErr = `grep: ${p}: No such file or directory`;
                hasError = true;
                return;
            }
            if (entry.constructor === Object) {
                if (!recursive) {
                    this.stdErr = `grep: ${p}: Is a directory`;
                    hasError = true;
                    return;
                }
                for (const name of Object.keys(entry)) {
                    collectFiles(p.replace(/\/$/, '') + '/' + name);
                }
                return;
            }
            files.push({ path: p, content: entry.toString() });
        };

        for (const p of paths) collectFiles(p);

        if (hasError && files.length === 0) {
            this.exitCode = 2;
            return Promise.resolve();
        }

        const multiFile = files.length > 1;
        let anyMatch = false;

        for (const { path: filePath, content } of files) {
            const lines = content.split('\n');
            let matchCount = 0;
            const hits = [];

            for (let ln = 0; ln < lines.length; ln++) {
                const isMatch = regex.test(lines[ln]);
                if (isMatch !== invertMatch) {
                    matchCount++;
                    hits.push({ text: lines[ln], num: ln + 1 });
                }
            }

            if (matchCount > 0) anyMatch = true;
            if (quiet) continue;

            if (listFiles) {
                if (matchCount > 0) this.stdOut = filePath;
                continue;
            }

            if (countOnly) {
                this.stdOut = multiFile ? `${filePath}:${matchCount}` : String(matchCount);
                continue;
            }

            for (const { text, num } of hits) {
                const filePfx = multiFile ? `${filePath}:` : '';
                const linePfx = lineNumbers ? `${num}:` : '';
                this.stdOut = `${filePfx}${linePfx}${text}`;
            }
        }

        if (!anyMatch && !hasError) this.exitCode = 1;
        if (hasError) this.exitCode = 2;

        return Promise.resolve();
    }
}

module.exports = Grep;

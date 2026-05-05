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
        let listNonMatching = false;
        let quiet = false;
        let recursive = false;
        let fixedString = false;
        let onlyMatching = false;
        let wordMatch = false;
        let lineMatch = false;
        let suppressErrors = false;
        let patternFile = null;
        const patterns = [];
        const paths = [];

        const args = [...this.arguments];
        let i = 0;

        while (i < args.length) {
            const arg = args[i];
            if (arg === '--') { i++; break; }

            if (arg.startsWith('-') && arg.length > 1) {
                const flags = arg.slice(1);
                let skipRest = false;
                for (let j = 0; j < flags.length && !skipRest; j++) {
                    switch (flags[j]) {
                        case 'i': ignoreCase = true; break;
                        case 'v': invertMatch = true; break;
                        case 'n': lineNumbers = true; break;
                        case 'c': countOnly = true; break;
                        case 'l': listFiles = true; break;
                        case 'L': listNonMatching = true; break;
                        case 'q': quiet = true; break;
                        case 'r': case 'R': recursive = true; break;
                        case 'F': fixedString = true; break;
                        case 'E': break;
                        case 'o': onlyMatching = true; break;
                        case 'w': wordMatch = true; break;
                        case 'x': lineMatch = true; break;
                        case 's': suppressErrors = true; break;
                        case 'a': break;
                        case 'e': {
                            const rest = flags.slice(j + 1);
                            patterns.push(rest.length > 0 ? rest : args[++i]);
                            skipRest = true;
                            break;
                        }
                        case 'f': {
                            const rest = flags.slice(j + 1);
                            patternFile = rest.length > 0 ? rest : args[++i];
                            skipRest = true;
                            break;
                        }
                        default:
                            if (!suppressErrors) {
                                this.stdErr = `grep: invalid option -- '${flags[j]}'`;
                            }
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

        // -f: read patterns from file or stdin
        if (patternFile !== null) {
            let pfContent = '';
            if (patternFile === '-') {
                pfContent = this.stdin || '';
            } else {
                const pf = this.fs.getFileByPath(patternFile);
                if (pf === null || pf === undefined) {
                    if (!suppressErrors) this.stdErr = `grep: ${patternFile}: No such file or directory`;
                    this.exitCode = 2;
                    return Promise.resolve();
                }
                pfContent = pf.toString();
            }
            for (const p of pfContent.split('\n')) {
                if (p.length > 0) patterns.push(p);
            }
        }

        // First non-flag arg becomes the pattern if no -e/-f patterns
        if (patterns.length === 0) {
            if (paths.length === 0) {
                this.stdErr = 'grep: no pattern given';
                this.exitCode = 2;
                return Promise.resolve();
            }
            patterns.push(paths.shift());
        }

        // Build one regex per pattern
        const rxFlags = ignoreCase ? 'gi' : 'g';
        const regexes = [];
        for (const pat of patterns) {
            let src = fixedString ? pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pat;
            if (wordMatch) src = `(?:^|\\W)(?:${src})(?:\\W|$)`;
            if (lineMatch) src = `^(?:${src})$`;
            try {
                regexes.push(new RegExp(src, rxFlags));
            } catch(e) {
                this.stdErr = `grep: invalid regex: ${e.message}`;
                this.exitCode = 2;
                return Promise.resolve();
            }
        }

        // Collect input sources: {label, content}
        const sources = [];
        let hasError = false;
        const stdinContent = this.stdin || '';

        const collectFiles = (p) => {
            const entry = this.fs.getFileByPath(p);
            if (entry === null || entry === undefined) {
                if (!suppressErrors) this.stdErr = `grep: ${p}: No such file or directory`;
                hasError = true;
                return;
            }
            if (entry.constructor === Object) {
                if (!recursive) {
                    if (!suppressErrors) this.stdErr = `grep: ${p}: Is a directory`;
                    hasError = true;
                    return;
                }
                for (const name of Object.keys(entry)) {
                    collectFiles(p.replace(/\/$/, '') + '/' + name);
                }
                return;
            }
            sources.push({ label: p, content: entry.toString() });
        };

        if (paths.length === 0) {
            sources.push({ label: null, content: stdinContent });
        } else {
            for (const p of paths) {
                if (p === '-') {
                    sources.push({ label: '(standard input)', content: stdinContent });
                } else {
                    collectFiles(p);
                }
            }
        }

        const multiSource = sources.length + (hasError ? 1 : 0) > 1;
        let anyMatch = false;

        const testLine = (line) => {
            if (regexes.length === 0) return false;
            for (const rx of regexes) {
                rx.lastIndex = 0;
                if (rx.test(line)) return true;
            }
            return false;
        };

        const collectMatches = (line) => {
            const segments = [];
            for (const rx of regexes) {
                rx.lastIndex = 0;
                let m;
                while ((m = rx.exec(line)) !== null) {
                    if (m[0].length === 0) { rx.lastIndex++; continue; }
                    segments.push(m[0]);
                    if (!rx.global) break;
                }
            }
            return segments;
        };

        for (const { label, content } of sources) {
            let lines = content.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

            let matchCount = 0;
            const hits = [];

            for (let ln = 0; ln < lines.length; ln++) {
                const line = lines[ln];
                let isMatch;
                let segments = [];

                if (onlyMatching && !invertMatch) {
                    segments = collectMatches(line);
                    isMatch = segments.length > 0;
                } else {
                    isMatch = testLine(line);
                }

                if (isMatch !== invertMatch) {
                    matchCount++;
                    hits.push({ text: line, num: ln + 1, segments });
                }
            }

            if (listNonMatching) {
                // -L: print files with NO match; success = printed something
                if (matchCount === 0) {
                    this.stdOut = label || '(standard input)';
                    anyMatch = true;
                }
                continue;
            }

            if (matchCount > 0) anyMatch = true;

            if (quiet) continue;

            if (listFiles) {
                if (matchCount > 0) this.stdOut = label || '(standard input)';
                continue;
            }

            if (countOnly) {
                const pfx = multiSource && label ? `${label}:` : '';
                this.stdOut = `${pfx}${matchCount}`;
                continue;
            }

            for (const { text, num, segments } of hits) {
                const filePfx = multiSource && label ? `${label}:` : '';
                const linePfx = lineNumbers ? `${num}:` : '';
                if (onlyMatching) {
                    for (const seg of segments) {
                        this.stdOut = `${filePfx}${linePfx}${seg}`;
                    }
                } else {
                    this.stdOut = `${filePfx}${linePfx}${text}`;
                }
            }
        }

        // SUSv3: -q with a match exits 0 even if there were also file errors
        if (hasError && !(quiet && anyMatch)) this.exitCode = 2;
        else if (!anyMatch) this.exitCode = 1;

        return Promise.resolve();
    }
}

module.exports = Grep;

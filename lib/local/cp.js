'use strict';

const LocalCommand = require('./LocalCommand');
const nodeFs = require('fs');

class Cp extends LocalCommand {
    get name() { return 'cp'; }
    get requiresFilesystem() { return true; }

    run() {
        let recursive = false;
        // symlinkMode: 'follow' | 'preserve' | 'follow_cl'
        // 'follow'    - dereference all symlinks
        // 'preserve'  - keep symlinks as symlinks (default with -R)
        // 'follow_cl' - follow command-line symlinks, preserve during recursion (-H)
        let symlinkMode = null;  // null = unset; resolved after parsing
        let rSeen = false;
        const paths = [];

        const args = [...this.arguments];
        let i = 0;
        while (i < args.length) {
            const arg = args[i];
            if (arg === '--') { i++; break; }
            if (arg.startsWith('-') && arg.length > 1) {
                for (const ch of arg.slice(1)) {
                    switch (ch) {
                        case 'r': case 'R': recursive = true; rSeen = true; break;
                        case 'd': case 'P': symlinkMode = 'preserve'; break;
                        case 'L': symlinkMode = 'follow'; break;
                        case 'H': symlinkMode = 'follow_cl'; break;
                        case 'f': break;
                    }
                }
            } else {
                paths.push(arg);
            }
            i++;
        }
        while (i < args.length) paths.push(args[i++]);

        // Resolve default symlink mode: -R without explicit flag → preserve
        const resolvedMode = symlinkMode !== null ? symlinkMode
            : rSeen ? 'preserve'
            : 'follow';

        if (paths.length < 2) {
            this.stdErr = `cp: missing destination file operand${paths.length ? ` after '${paths[0]}'` : ''}`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        const dest = paths[paths.length - 1];
        const sources = paths.slice(0, -1);
        const destEntry = this.fs.getFileByPath(dest);
        const destIsDir = destEntry !== null && destEntry !== undefined && destEntry.constructor === Object;

        // Determine per-item copy mode and the mode for recursive children
        // 'follow_cl': at CL level use 'follow'; for children use 'preserve'
        const clItemMode = resolvedMode === 'follow_cl' ? 'follow' : resolvedMode;
        const childMode = resolvedMode === 'follow_cl' ? 'preserve' : resolvedMode;

        for (const src of sources) {
            const isLink = this.fs.isSymlink ? this.fs.isSymlink(src) : false;

            // Stat (follows symlinks) to get effective type
            const stat = this.fs.getFileByPath(src);
            if (stat === null || stat === undefined) {
                this.stdErr = `cp: cannot stat '${src}': No such file or directory`;
                this.exitCode = 1;
                continue;
            }

            // If we're preserving this symlink, it won't become a directory
            const effectiveIsDir = (isLink && clItemMode === 'preserve')
                ? false
                : stat.constructor === Object;

            if (effectiveIsDir && !recursive) {
                this.stdErr = `cp: omitting directory '${src}'`;
                this.exitCode = 1;
                continue;
            }

            const targetPath = destIsDir
                ? dest.replace(/\/$/, '') + '/' + src.split('/').pop()
                : dest;

            const err = this._copy(src, targetPath, clItemMode, isLink, childMode);
            if (err) {
                this.stdErr = err;
                this.exitCode = 1;
            }
        }
        return Promise.resolve();
    }

    // mode:      how to handle symlinks for this item ('follow' | 'preserve')
    // childMode: how to handle symlinks for recursive children
    _copy(src, dest, mode, isLink, childMode) {
        if (isLink && mode === 'preserve' && this.fs.readSymlink) {
            const target = this.fs.readSymlink(src);
            if (target === null) return `cp: cannot read symlink '${src}'`;
            try {
                this.fs.createSymlink(target, dest);
            } catch(e) {
                return `cp: cannot create symlink '${dest}': ${e.message}`;
            }
            return null;
        }

        const content = this.fs.getFileByPath(src);
        if (content === null || content === undefined) {
            return `cp: cannot stat '${src}': No such file or directory`;
        }

        if (content.constructor === Object) {
            try {
                this.fs.setFileByPath(dest, {}, true);
            } catch(e) {
                return `cp: cannot create directory '${dest}': ${e.message}`;
            }

            const absDir = this.fs.absolutePath(src);
            let entries;
            try {
                entries = nodeFs.readdirSync(absDir);
            } catch(e) {
                entries = Object.keys(content);
            }

            for (const name of entries) {
                const childSrc = src.replace(/\/$/, '') + '/' + name;
                const childDest = dest.replace(/\/$/, '') + '/' + name;
                const childIsLink = this.fs.isSymlink ? this.fs.isSymlink(childSrc) : false;
                const err = this._copy(childSrc, childDest, childMode, childIsLink, childMode);
                if (err) {
                    this.stdErr = err;
                    this.exitCode = 1;
                }
            }
        } else {
            this.fs.setFileByPath(dest, content, true);
        }
        return null;
    }
}

module.exports = Cp;

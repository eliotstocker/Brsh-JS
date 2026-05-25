'use strict';

const LocalCommand = require('./LocalCommand');
const nodeFs = (() => { try { return require('fs'); } catch { return null; } })();

class Stat extends LocalCommand {
    static get name() { return 'stat'; }
    get requiresFilesystem() { return true; }

    run() {
        const paths = [];
        for (const arg of this.arguments) {
            if (arg === '--' ) break;
            if (!arg.startsWith('-')) paths.push(arg);
            // -L (follow symlinks) is already our default; other flags ignored
        }

        if (paths.length === 0) {
            this.stdErr = 'stat: missing operand';
            this.exitCode = 1;
            return Promise.resolve();
        }

        for (const path of paths) {
            const isLink = this.fs.isSymlink ? this.fs.isSymlink(path) : false;
            if (!this.fs.exists(path) && !isLink) {
                this.stdErr = `stat: cannot stat '${path}': No such file or directory`;
                this.exitCode = 1;
                continue;
            }
            this.stdOut = this._format(path, isLink);
        }
        return Promise.resolve();
    }

    _format(path, isLink) {
        const abs = this.fs.absolutePath(path);

        // Real filesystem — use lstat for accurate info
        if (this.fs.isRealFilesystem && nodeFs) {
            try {
                const st = nodeFs.lstatSync(abs);
                const typChar = st.isSymbolicLink() ? 'l'
                    : st.isDirectory() ? 'd'
                    : '-';
                const typeName = st.isSymbolicLink() ? 'symbolic link'
                    : st.isDirectory() ? 'directory'
                    : 'regular file';
                const modeOctal = (st.mode & 0o777).toString(8).padStart(4, '0');
                const modeStr = typChar + this._rwxBits(st.mode & 0o777);
                const linkTarget = st.isSymbolicLink() ? ` -> ${nodeFs.readlinkSync(abs)}` : '';
                return [
                    `  File: ${abs}${linkTarget}`,
                    `  Size: ${st.size}\t\tBlocks: ${st.blocks}\t\tIO Block: ${st.blksize}\t${typeName}`,
                    `Device: ${st.dev}\t\tInode: ${st.ino}\t\tLinks: ${st.nlink}`,
                    `Access: (${modeOctal}/${modeStr})\tUid: ${st.uid}\tGid: ${st.gid}`,
                    `Access: ${st.atime.toISOString()}`,
                    `Modify: ${st.mtime.toISOString()}`,
                    `Change: ${st.ctime.toISOString()}`,
                ].join('\n');
            } catch(e) {
                return `stat: cannot stat '${path}': ${e.message}`;
            }
        }

        // Virtual filesystem — derive info from what we have
        const s = this.fs.stat(path);
        const mode = this.fs.getMode(path) ?? 0o644;
        const size = this.fs.getSize(path);
        const typChar = isLink ? 'l' : s?.isDirectory ? 'd' : '-';
        const typeName = isLink ? 'symbolic link'
            : s?.isDirectory ? 'directory'
            : s?.isCommand ? 'regular file'
            : 'regular file';
        const modeOctal = mode.toString(8).padStart(4, '0');
        const modeStr = typChar + this._rwxBits(mode);
        const linkTarget = isLink && this.fs.readSymlink ? ` -> ${this.fs.readSymlink(path)}` : '';
        return [
            `  File: ${abs}${linkTarget}`,
            `  Size: ${size}\t\tType: ${typeName}`,
            `Access: (${modeOctal}/${modeStr})`,
        ].join('\n');
    }

    _rwxBits(mode) {
        return [
            (mode & 0o400) ? 'r' : '-', (mode & 0o200) ? 'w' : '-', (mode & 0o100) ? 'x' : '-',
            (mode & 0o040) ? 'r' : '-', (mode & 0o020) ? 'w' : '-', (mode & 0o010) ? 'x' : '-',
            (mode & 0o004) ? 'r' : '-', (mode & 0o002) ? 'w' : '-', (mode & 0o001) ? 'x' : '-',
        ].join('');
    }
}

module.exports = Stat;

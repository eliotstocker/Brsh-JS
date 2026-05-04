'use strict';

const LocalCommand = require('./LocalCommand');

class Chmod extends LocalCommand {
    get name() { return 'chmod'; }
    get requiresFilesystem() { return true; }

    run() {
        const args = this.arguments;
        if (args.length < 2) {
            this.stdErr = 'chmod: usage: chmod MODE FILE...';
            this.exitCode = 1;
            return Promise.resolve();
        }

        const modeStr = args[0];
        const paths = args.slice(1);

        for (const p of paths) {
            const file = this.fs.getFileByPath(p);
            if (file === null || file === undefined) {
                this.stdErr = `chmod: cannot access '${p}': No such file or directory`;
                this.exitCode = 1;
                continue;
            }

            const currentMode = this.fs.getMode(p);
            const mode = this._parseMode(modeStr, currentMode !== null ? currentMode : 0o644);
            if (mode === null) {
                this.stdErr = `chmod: invalid mode: '${modeStr}'`;
                this.exitCode = 1;
                return Promise.resolve();
            }
            this.fs.setMode(p, mode);
        }
        return Promise.resolve();
    }

    _parseMode(str, current) {
        if (/^0?[0-7]{3,4}$/.test(str)) {
            return parseInt(str, 8);
        }
        const match = str.match(/^([ugoa]*)([+\-=])([rwx]+)$/);
        if (!match) return null;

        const [, who, op, perms] = match;
        const targets = (!who || who === 'a') ? ['u', 'g', 'o'] : who.split('');

        const R = { u: 0o400, g: 0o040, o: 0o004 };
        const W = { u: 0o200, g: 0o020, o: 0o002 };
        const X = { u: 0o100, g: 0o010, o: 0o001 };

        let mask = 0;
        for (const t of targets) {
            if (perms.includes('r')) mask |= R[t];
            if (perms.includes('w')) mask |= W[t];
            if (perms.includes('x')) mask |= X[t];
        }

        if (op === '+') return current | mask;
        if (op === '-') return current & ~mask;
        if (op === '=') {
            let clear = 0;
            for (const t of targets) { clear |= R[t] | W[t] | X[t]; }
            return (current & ~clear) | mask;
        }
        return null;
    }
}

module.exports = Chmod;

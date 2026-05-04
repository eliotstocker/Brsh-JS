'use strict';

const Command = require('../Command');
const commandLineArgs = require('command-line-args');

class Ls extends Command {
    get requiresFilesystem() {
        return true;
    }

    run() {
        let options;
        try {
            options = this.parseArgs();
        } catch(e) {
            this.printHelp(e);
            return Promise.reject();
        }

        if(options.help) {
            this.printHelp();
            return Promise.resolve();
        }

        const file = this.fs.getFileByPath(options.path);

        if(!file) {
            return Promise.reject(`${options.path}: No such file or directory`);
        }

        if(file.constructor === Object) {
            let items = file;
            if(!options.all) {
                items = Object.entries(items).reduce((acc, [name, content]) => {
                    if(!name.startsWith('.')) {
                        acc[name] = content;
                    }
                    return acc;
                }, {});
            }
            if(options.long) {
                this.printLong(items, options.path);
            } else {
                this.printSimple(Object.keys(items));
            }
            return Promise.resolve();
        }

        return Promise.resolve(options.path);
    }

    printHelp(e) {
        if(e) {
            this.stdOut = e.message;
        }
        this.stdOut = 'usage: ls [-alh] [file ...]'
    }

    printSimple(items) {
        this.stdOut = items.reduce((out, item) => out + this.padString(item), '');
    }

    printLong(items, basePath) {
        Object.entries(items).forEach(([name, content]) => {
            const itemPath = basePath + '/' + name;
            const isDir = content !== null && content !== undefined && content.constructor === Object;
            const rawMode = this.fs.getMode(itemPath);
            const mode = rawMode !== null ? rawMode : (isDir ? 0o755 : 0o644);
            const permStr = this._modeToString(mode, isDir);
            const size = isDir ? JSON.stringify(content).length : content.toString().length;
            return this.stdOut = `${permStr}   root  users  ${this.padString(size, 10)} ${name}`;
        });
    }

    _modeToString(mode, isDir) {
        const d = isDir ? 'd' : '-';
        return d +
            ((mode & 0o400) ? 'r' : '-') +
            ((mode & 0o200) ? 'w' : '-') +
            ((mode & 0o100) ? 'x' : '-') +
            ((mode & 0o040) ? 'r' : '-') +
            ((mode & 0o020) ? 'w' : '-') +
            ((mode & 0o010) ? 'x' : '-') +
            ((mode & 0o004) ? 'r' : '-') +
            ((mode & 0o002) ? 'w' : '-') +
            ((mode & 0o001) ? 'x' : '-');
    }

    padString(content, size = 16) {
        const pad = size - content.toString().length;
        let padding = '';
        for(let i = 0; i < pad; i++) {
            padding += ' ';
        }

        return content.toString() + padding;
    }

    parseArgs() {
        return commandLineArgs([
            {
                name: 'path',
                defaultOption: true,
                defaultValue: './',
                type: String
            },
            {
                name: 'all',
                alias: 'a',
                type: Boolean
            },
            {
                name: 'long',
                alias: 'l',
                type: Boolean
            },
            {
                name: 'help',
                alias: 'h',
                type: Boolean
            }
        ], {argv: this.arguments});
    }
}

module.exports = Ls;

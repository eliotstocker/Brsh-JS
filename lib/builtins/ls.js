'use strict';

const Command = require('../Command');
const commandLineArgs = require('command-line-args');

class Ls extends Command {
    get requiresFilesystem() {
        return true;
    }

    run() {
        // Pre-process numeric flags that command-line-args can't handle as aliases
        const rawArgs = this.arguments.filter(a => a !== '-1');
        const onePerLine = rawArgs.length !== this.arguments.length;

        let options;
        try {
            options = this.parseArgs(rawArgs);
        } catch(e) {
            this.printHelp(e);
            return Promise.reject();
        }
        options.one = options.one || onePerLine;

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

            const absBase = this.fs.absolutePath(options.path);

            if(options.long) {
                this.printLong(items, absBase);
            } else if (options.one) {
                Object.entries(items).forEach(([name, content]) => {
                    this.stdOut = this._applyIndicator(name, content, options.classify);
                });
            } else {
                this.printSimple(items, options.classify);
            }

            if (options.recursive) {
                Object.entries(items).forEach(([name, content]) => {
                    if (content && content.constructor === Object) {
                        const subPath = absBase.endsWith('/') ? absBase + name : absBase + '/' + name;
                        this.stdOut = '';
                        this.stdOut = subPath + ':';
                        this.run.call(
                            Object.create(this, {
                                arguments: { value: [
                                    ...this.arguments.filter(a => a !== options.path && a !== './'),
                                    subPath
                                ]}
                            })
                        );
                    }
                });
            }

            return Promise.resolve();
        }

        return Promise.resolve(options.path);
    }

    printHelp(e) {
        if(e) {
            this.stdOut = e.message;
        }
        this.stdOut = 'usage: ls [-alRF1h] [file ...]'
    }

    printSimple(items, classify) {
        this.stdOut = Object.entries(items).reduce((out, [name, content]) => {
            return out + this.padString(this._applyIndicator(name, content, classify));
        }, '');
    }

    printLong(items, basePath) {
        Object.entries(items).forEach(([name, content]) => {
            const itemPath = basePath + '/' + name;
            const isDir = content !== null && content !== undefined && content.constructor === Object;
            const rawMode = this.fs.getMode(itemPath);
            const mode = rawMode !== null ? rawMode : (isDir ? 0o755 : 0o644);
            const permStr = this._modeToString(mode, isDir);
            const size = this.fs.getSize(itemPath);
            return this.stdOut = `${permStr}   root  users  ${this.padString(size, 10)} ${name}`;
        });
    }

    _applyIndicator(name, content, classify) {
        if (!classify) return name;
        if (content && content.constructor === Object) return name + '/';
        if (typeof content === 'function' || this.fs.isExecutable(name)) return name + '*';
        return name;
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

    parseArgs(argv = this.arguments) {
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
                name: 'recursive',
                alias: 'R',
                type: Boolean
            },
            {
                name: 'one',
                type: Boolean
            },
            {
                name: 'classify',
                alias: 'F',
                type: Boolean
            },
            {
                name: 'help',
                alias: 'h',
                type: Boolean
            }
        ], {argv});
    }
}

module.exports = Ls;

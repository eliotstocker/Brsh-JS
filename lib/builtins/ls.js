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
                this.printLong(items);
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

    printLong(items) {
        Object.entries(items).forEach(([path, content]) => {
            if(content.constructor === Object) {
                return this.stdOut = `drwxr-xr-x   root  users  ${this.padString(JSON.stringify(content).length, 10)} ${path}`
            }
            return this.stdOut = `-rw-r--r--   root  users  ${this.padString(content.toString().length, 10)} ${path}`
        });
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
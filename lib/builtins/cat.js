'use strict';

const Command = require('../Command');

class Cat extends Command {
    get requiresFilesystem() {
        return true;
    }

    run() {
        if(this.arguments.length !== 1) {
            return Promise.reject('cat command requires a single argument');
        }

        const file = this.fs.getFileByPath(this.arguments[0]);

        if(!file) {
            return Promise.reject(`${this.arguments[0]}: No such file or directory`);
        }

        if(file.constructor === Object) {
            return Promise.reject(`${this.arguments[0]}: Is a directory`);
        }

        return Promise.resolve(file);
    }
}

module.exports = Cat;
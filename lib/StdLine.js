'use strict';

const allowedType = ['out', 'err'];

class StdLine {
    constructor(type, string) {
        if(!allowedType.includes(type)) {
            throw new Error('incorrect std output type');
        }
        this.type = type;
        this.string = string;
    }
}

module.exports = StdLine;
'use strict';

const Block = require('./Block');

class For extends Block {
    static matchBlock(input) {
        return input.startsWith('for') && input.includes('in');
    }

    static matchBlockEnd(input) {
        return input === 'done';
    }

    run(block) {
    }

    parseInput() {
    }
}

module.exports = For;
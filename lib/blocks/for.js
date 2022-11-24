const Block = require('./Block');

class For extends Block {
    static matchBlock(input) {
        return input.startsWith('For [') && input.endsWith(']');
    }

    static matchBlockEnd(input) {
        return input === 'done';
    }
}

module.exports = For;
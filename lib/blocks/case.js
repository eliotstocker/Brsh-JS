const Block = require('./Block');

class Case extends Block {
    static matchBlock(input) {
        return input.startsWith('case') && input.endsWith('in');
    }

    static matchBlockEnd(input) {
        return input === 'esac';
    }
}

module.exports = Case;
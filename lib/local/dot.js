'use strict';

const Source = require('./source');

class Dot extends Source {
    static get name() { return '.'; }
}

module.exports = Dot;

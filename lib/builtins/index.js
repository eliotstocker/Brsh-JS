'use strict';

const { Test, TestBracket } = require('./test');

module.exports = [
    require('./cat'),
    require('./ls'),
    require('./echo'),
    require('./true'),
    require('./false'),
    Test,
    TestBracket,
];

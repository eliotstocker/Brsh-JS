'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
    "root": {
        ".profile": fs.readFileSync(path.resolve(__dirname, 'root/.profile'), 'utf8'),
        motd: fs.readFileSync(path.resolve(__dirname, 'root/motd'), 'utf8'),
        ansitest: require('./root/ansitest')
    }
};
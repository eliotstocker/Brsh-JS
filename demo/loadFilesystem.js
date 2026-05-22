'use strict';

function loadFilesystem() {
    if(typeof globalThis !== 'undefined'
        && globalThis.fs
        && globalThis.fs.filesystem
    ) {
        return globalThis.fs.filesystem;
    }

    const path = require('path');
    const { buildStructure } = require('../lib/buildFilesystemStructure');

    return buildStructure(path.join(__dirname, 'filesystem')).filesystem;
}

module.exports = loadFilesystem();
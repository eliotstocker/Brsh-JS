'use strict';

const Terminal = require('../lib/terminal');

const term = new Terminal({
    el: document.body,
    profile: '/root/.profile',
    cwd: '/root',
    filesystem: require('./filesystem')
});
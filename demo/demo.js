'use strict';

const Terminal = require('../lib/Terminal');

const term = new Terminal({
    el: document.body,
    profile: '/root/.profile',
    cwd: '/root',
    filesystem: require('./filesystem'),
    cursor: 'blink',
    outputAnimation: 'type',
    animateSpeed: 2
});
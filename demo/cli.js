'use strict';

const Shell = require('../index');
const readline = require('readline');

const shell = new Shell({
    profile: '/root/.profile',
    cwd: '/root',
    filesystem: require('./filesystem')
});

shell.on('stdOut', line => {
    console.log(line);
});

shell.on('stdErr', line => {
    console.error(line);
});

shell.on('clear', () => {
    console.clear();
});

shell.on('exit', code => {
    process.exit(code);
});

shell.on('status', status => {
    if(status === Shell.STATUS_READY) {
        process.stdout.write('# ');
    }
});

process.stdin.resume();
process.stdin.setEncoding('utf8');

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
});

rl.on('line', function(line){
    shell.onCommand(line);
});

process.stdin.on('keypress', (str) => {
    shell.onInput(str);
});
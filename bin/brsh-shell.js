#!/usr/bin/env node
'use strict';

// Interactive brsh shell against the real filesystem.
// Run via:  npm run shell

const Shell = require('../index.js');
const readline = require('readline');

const shell = new Shell({
    useRealFilesystem: true,
    cwd: process.cwd(),
    hostname: require('os').hostname().split('.')[0]
});

shell.on('stdOut', line => process.stdout.write(line + '\n'));
shell.on('stdErr', line => process.stderr.write(line + '\n'));
let destroyed = false;
shell.on('exit', code => {
    destroyed = true;
    rl.close();
    process.exit(code);
});
shell.on('status', status => {
    if (status === Shell.STATUS_READY) {
        ask();
    }
});

function prompt() {
    const cwd = (shell.context.fs && shell.context.fs.cwd) || '~';
    const host = shell.context.getVar('HOST') || 'brsh';
    return `${host}:${cwd}$ `;
}

function completer(line) {
    const tokens = line.split(/\s+/);
    const partial = tokens[tokens.length - 1];
    const result = shell.context.fs.autoComplete(partial, shell.context.getVar('PATH'));
    if (!result) return [[], partial];
    const prefix = result.path ? result.path + '/' : '';
    const completions = result.options.map(opt => prefix + opt);
    return [completions, partial];
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer
});

function ask() {
    rl.question(prompt(), line => {
        if (line === null) {
            rl.close();
            process.exit(0);
        }
        shell.onCommand(line)
            .then(() => ask())
            .catch(() => ask());
    });
}

rl.on('close', () => { if (!destroyed) process.exit(0); });

// Forward typed lines to commands waiting for input (e.g. `read`)
rl.on('line', function(line) {
    if (shell.runningCommand && shell.runningCommand.captureInput) {
        for (const char of line) { shell.onInput(char); }
        shell.onInput('Enter');
    }
});

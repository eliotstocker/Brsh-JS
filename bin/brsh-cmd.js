#!/usr/bin/env node
'use strict';

// Multi-call CLI for brsh builtins.
// Symlink this file as the command name (echo, cat, grep, …) and it will
// run that command through brsh with useRealFilesystem enabled.
//
// Usage (via symlink):  echo hello world
// Usage (direct):       brsh-cmd.js echo hello world

const Shell = require('../index.js');
const nodePath = require('path');

const scriptName = nodePath.basename(process.argv[1]).replace(/\.js$/, '');
const isMultiCall = scriptName === 'brsh-cmd';

const cmdName = isMultiCall ? process.argv[2] : scriptName;
const args = isMultiCall ? process.argv.slice(3) : process.argv.slice(2);

if (!cmdName) {
    process.stderr.write('usage: brsh-cmd <command> [args...]\n');
    process.exit(1);
}

function shellQuote(s) {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

const commandLine = cmdName + (args.length ? ' ' + args.map(shellQuote).join(' ') : '');

const shell = new Shell({
    useRealFilesystem: true,
    cwd: process.cwd(),
    hostname: 'brsh'
});

let exitCode = 0;
let ran = false;

shell.on('stdOut', line => process.stdout.write(line + '\n'));
shell.on('stdErr', line => process.stderr.write(line + '\n'));
shell.on('exitCode', code => { exitCode = code; });

shell.on('status', status => {
    if (status === Shell.STATUS_READY && !ran) {
        ran = true;
        shell.onCommand(commandLine)
            .then(() => process.exit(exitCode))
            .catch(() => process.exit(1));
    }
});

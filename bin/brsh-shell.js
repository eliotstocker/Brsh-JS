#!/usr/bin/env node
'use strict';

// brsh shell — interactive REPL or non-interactive command runner.
//
// Usage:
//   brsh-shell                        interactive REPL
//   brsh-shell -c "cmd"               run a single command and exit
//   brsh-shell script.sh [arg1 ...]   run a script file and exit
//   brsh-shell -e -x script.sh        run with shell flags active from the start
//   brsh-shell -i -c "cmd"            force interactive after running -c

const Shell = require('../index.js');
const Wbt = require('../lib/wbt');
const Pico = require('../demo/pico');
const { buildStructure } = require('../lib/buildFilesystemStructure');
const nodePath = require('path');

function resolveRequireNodes(node) {
    if (!node || typeof node !== 'object') return node;
    for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
            const m = v.match(/^require\('(.*)'\)$/);
            if (m) {
                try { node[k] = require(m[1]); } catch { /* ignore */ }
            }
        } else if (v && typeof v === 'object') {
            resolveRequireNodes(v);
        }
    }
    return node;
}

// ── CLI argument parsing ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let commandString = null;  // -c "string"
let scriptFile = null;     // positional script path
let scriptArgs = [];       // args after the script filename
const shellFlags = [];     // single-char flags to activate via `set`
let forceInteractive = false;
let demoMode = false;

for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
        if (scriptFile) scriptArgs = argv.slice(i + 1);
        break;
    }
    if (arg === '--demo') {
        demoMode = true;
        continue;
    }
    if (arg === '-c') {
        commandString = argv[++i] !== undefined ? argv[i] : '';
        continue;
    }
    if (arg === '-i') {
        forceInteractive = true;
        continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
        // Flags like -e, -x, -u, -n, or combined -ex
        shellFlags.push(...arg.slice(1));
        continue;
    }
    // First non-flag argument is the script file; the rest are its positional args
    scriptFile = arg;
    scriptArgs = argv.slice(i + 1);
    break;
}

const isInteractive = forceInteractive || (commandString === null && scriptFile === null);

// ── Shell setup ───────────────────────────────────────────────────────────────

let shellOptions;
if (demoMode) {
    const demoDir = nodePath.resolve(__dirname, '../demo/filesystem');
    const { filesystem, permissions } = buildStructure(demoDir);
    resolveRequireNodes(filesystem);
    shellOptions = {
        filesystem,
        permissions,
        profile: '/root/.profile',
        cwd: '/root',
        hostname: 'brsh'
    };
} else {
    shellOptions = {
        useRealFilesystem: true,
        cwd: process.cwd(),
        hostname: require('os').hostname().split('.')[0]
    };
}

const shell = new Shell(shellOptions);
shell.context.setCommand(Wbt);
shell.context.setCommand(Pico);

// ── Terminal streams & size reporting ─────────────────────────────────────────

function reportSize() {
    if (process.stdout.isTTY) {
        shell.setTerminalSize(process.stdout.columns || 80, process.stdout.rows || 24);
    }
}

process.stdout.on('resize', reportSize);
reportSize();

// ── Non-interactive execution ─────────────────────────────────────────────────

async function runNonInteractive() {
    // Apply any shell flags (-e, -x, etc.) first
    if (shellFlags.length > 0) {
        await shell.onCommand(`set -${shellFlags.join('')}`, false);
    }

    if (commandString !== null) {
        // -c mode: run the command string directly
        await shell.onCommand(commandString, false);
    } else {
        // Script file mode: set positional params then run the script
        const absScript = nodePath.resolve(process.cwd(), scriptFile);
        if (scriptArgs.length > 0) {
            const quoted = scriptArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            await shell.onCommand(`set -- ${quoted}`, false);
        }
        // Use the absolute path; _parseCommand will find it on the real filesystem.
        // If the file lacks execute permission, fall back to source.
        const runCmd = `"${absScript.replace(/"/g, '\\"')}"`;
        await shell.onCommand(runCmd, false).catch(async () => {
            await shell.onCommand(`source "${absScript.replace(/"/g, '\\"')}"`, false);
        });
    }

    const exitCode = parseInt(shell.context.getVar('?') || '0', 10);
    process.exit(exitCode);
}

if (!isInteractive) {
    shell.stdout.pipe(process.stdout);
    shell.stderr.pipe(process.stderr);
    process.stdin.pipe(shell.stdinStream);

    const onReady = status => {
        if (status === Shell.STATUS_READY) {
            shell.removeListener('status', onReady);
            runNonInteractive();
        }
    };
    shell.on('status', onReady);
    return;
}

// ── Interactive mode ──────────────────────────────────────────────────────────

if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
}

process.stdin.pipe(shell.stdinStream);
shell.stdout.pipe(process.stdout);
shell.stderr.pipe(process.stderr);

shell.on('exit', code => {
    if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch (_) {}
    }
    process.exit(code);
});


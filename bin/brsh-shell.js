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
const readline = require('readline');
const nodePath = require('path');

// ── CLI argument parsing ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let commandString = null;  // -c "string"
let scriptFile = null;     // positional script path
let scriptArgs = [];       // args after the script filename
const shellFlags = [];     // single-char flags to activate via `set`
let forceInteractive = false;

for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
        if (scriptFile) scriptArgs = argv.slice(i + 1);
        break;
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

const shell = new Shell({
    useRealFilesystem: true,
    cwd: process.cwd(),
    hostname: require('os').hostname().split('.')[0]
});

let destroyed = false;
let rl;
let inInteractiveApp = false;

// ── Terminal size reporting ───────────────────────────────────────────────────

function reportSize() {
    if (process.stdout.isTTY) {
        shell.setTerminalSize(process.stdout.columns || 80, process.stdout.rows || 24);
    }
}

process.stdout.on('resize', () => { if (inInteractiveApp) reportSize(); });

shell.on('stdOut', line => {
    if (inInteractiveApp) {
        process.stdout.write(line);
    } else {
        process.stdout.write(line + '\n');
    }
});
shell.on('stdErr', line => process.stderr.write(line + '\n'));

shell.on('exit', code => {
    destroyed = true;
    if (rl) rl.close();
    process.exit(code);
});

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
    shell.once('status', status => {
        if (status === Shell.STATUS_READY) runNonInteractive();
    });
    return;
}

// ── Interactive mode ──────────────────────────────────────────────────────────

shell.on('status', status => {
    if (status !== Shell.STATUS_READY) return;
    if (inInteractiveApp) {
        inInteractiveApp = false;
        process.stdin.removeListener('data', rawDataHandler);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        rl.resume();
    }
    ask();
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

rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer
});

// Report initial terminal size so COLUMNS/LINES are correct from the start
reportSize();

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
    if (shell.runningCommand && shell.runningCommand.captureInput && !inInteractiveApp) {
        for (const char of line) { shell.onInput(char); }
        shell.onInput('Enter');
    }
});

// ── Raw key input for interactive full-screen apps ────────────────────────────

function parseRawKey(buf) {
    const str = buf.toString('binary');
    if (str.length === 1) {
        const code = str.charCodeAt(0);
        if (code === 0x0d || code === 0x0a) return 'Enter';
        if (code === 0x7f || code === 0x08) return 'Backspace';
        if (code === 0x09) return 'Tab';
        if (code === 0x1b) return 'Escape';
        if (code >= 0x01 && code <= 0x1a) return '^' + String.fromCharCode(code + 0x40);
        return str;
    }
    if (str.startsWith('\x1b[') || str.startsWith('\x1bO')) {
        const seq = str.slice(2);
        const named = {
            A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft',
            H: 'Home',    F: 'End',
            '1~': 'Home', '3~': 'Delete', '4~': 'End',
            '5~': 'PageUp', '6~': 'PageDown',
            '7~': 'Home', '8~': 'End'
        };
        return named[seq] || null;
    }
    return null;
}

function rawDataHandler(buf) {
    const key = parseRawKey(buf);
    if (key !== null) shell.onInput(key);
}

shell.on('interactive', () => {
    inInteractiveApp = true;
    reportSize();
    rl.pause();
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
    }
    process.stdin.on('data', rawDataHandler);
});


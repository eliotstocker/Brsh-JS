#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Context = require('../lib/Context');
const NodeFileSystem = require('../lib/NodeFileSystem');
const FileSystem = require('../lib/FileSystem');
const Wbt = require('../lib/wbt/index.js');

async function main() {
    const rawArgs = process.argv.slice(2);

    let rootDir = null;
    let allowSystemRoot = false;
    const wbtArgs = [];

    for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i];
        if (a === '--root' || a === '-r') {
            if (i + 1 < rawArgs.length) {
                rootDir = rawArgs[++i];
            }
        } else if (a.startsWith('--root=')) {
            rootDir = a.slice(7);
        } else if (a === '--allow-system-root') {
            allowSystemRoot = true;
        } else {
            wbtArgs.push(a);
        }
    }

    const firstArg = wbtArgs[0] ? wbtArgs[0].toLowerCase() : '';
    const isHelp = wbtArgs.length === 0 || wbtArgs.includes('--help') || wbtArgs.includes('-h') || firstArg === 'help';
    const isVersion = wbtArgs.includes('--version') || wbtArgs.includes('-v');
    const isStaticInspection = !rootDir && (firstArg === 'search' || firstArg === 'show' || firstArg === 'info');

    if (isHelp) {
        console.log('wbt [options] <command> [args...]');
        console.log('');
        console.log('Options:');
        console.log('  --root, -r <dir>       Target filesystem directory (required for install/remove/list/update)');
        console.log('  --allow-system-root    Allow operating on / as root directory');
        console.log('');
    }

    // Operations that require an explicit root directory
    if (!rootDir && !isHelp && !isVersion && !isStaticInspection) {
        const op = firstArg || 'this';
        console.error(`E: --root <dir> (-r <dir>) is required for '${op}' operation`);
        console.error(`Usage: wbt --root <dir> ${firstArg || '<command>'} [options]`);
        process.exit(1);
    }

    let resolvedRootDir = null;
    let targetFs = null;

    if (rootDir) {
        resolvedRootDir = path.resolve(rootDir);
        if ((resolvedRootDir === '/' || resolvedRootDir === path.resolve('/')) && !allowSystemRoot) {
            console.error("E: Refusing to operate on system root '/' without --allow-system-root");
            process.exit(1);
        }
        if (!fs.existsSync(resolvedRootDir)) {
            console.error(`E: Root directory '${resolvedRootDir}' does not exist`);
            process.exit(1);
        }
        targetFs = new NodeFileSystem('/', null, { rootDir: resolvedRootDir });
    } else {
        // Read-only static inspection (help, version, search, show) with minimal virtual FS
        targetFs = new FileSystem('/', { bin: {}, usr: { lib: {} } });
    }

    const context = new Context({
        env: { PATH: '/bin' },
        fs: targetFs
    });
    context.fs = targetFs;

    const instance = new Wbt(wbtArgs, context);
    if (instance.requiresFilesystem) {
        instance.fs = targetFs;
    }

    // Forward stdout & stderr to the host terminal
    if (instance.stdout && typeof instance.stdout.on === 'function') {
        instance.stdout.on('data', chunk => {
            process.stdout.write(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        });
    }
    if (instance.stderr && typeof instance.stderr.on === 'function') {
        instance.stderr.on('data', chunk => {
            process.stderr.write(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        });
    }

    try {
        await instance.runCommand();
    } catch (err) {
        console.error(`E: ${err.message || err}`);
        process.exit(1);
    }

    // Flush any buffered lines on the command instance
    if (instance.result) {
        for (const line of instance.result.getStdOutput()) {
            if (line.type === 'out') console.log(line.string);
            else if (line.type === 'err') console.error(line.string);
        }
    }

    process.exit(instance.exitCode !== undefined ? instance.exitCode : 0);
}

main().catch(err => {
    console.error(`E: ${err.message || err}`);
    process.exit(1);
});

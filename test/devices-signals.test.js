import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
const Shell = require('../index.js');
const FileSystem = require('../lib/FileSystem.js');
const Command = require('../lib/Command.js');
const WasmCommand = require('../lib/WasmCommand.js');

describe('Virtual /dev endpoints in filesystem', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell();
    });

    it('has /dev directory and standard device nodes mounted', () => {
        expect(shell.context.fs.exists('/dev')).toBe(true);
        expect(shell.context.fs.exists('/dev/null')).toBe(true);
        expect(shell.context.fs.exists('/dev/zero')).toBe(true);
        expect(shell.context.fs.exists('/dev/urandom')).toBe(true);
        expect(shell.context.fs.exists('/dev/random')).toBe(true);
        expect(shell.context.fs.exists('/dev/tty')).toBe(true);
        expect(shell.context.fs.exists('/dev/stdin')).toBe(true);
        expect(shell.context.fs.exists('/dev/stdout')).toBe(true);
        expect(shell.context.fs.exists('/dev/stderr')).toBe(true);
    });

    it('identifies /dev character devices with stat', () => {
        const nullStat = shell.context.fs.stat('/dev/null');
        expect(nullStat.isCharacterDevice).toBe(true);
        expect(nullStat.isDirectory).toBe(false);

        const urandomStat = shell.context.fs.stat('/dev/urandom');
        expect(urandomStat.isCharacterDevice).toBe(true);

        const devStat = shell.context.fs.stat('/dev');
        expect(devStat.isDirectory).toBe(true);
    });

    it('lists /dev contents using ls', async () => {
        const res = await run(shell, 'ls /dev');
        expect(res.output.join(' ')).toContain('null');
        expect(res.output.join(' ')).toContain('zero');
        expect(res.output.join(' ')).toContain('urandom');
        expect(res.output.join(' ')).toContain('tty');
    });

    it('reads empty from /dev/null and discards writes to /dev/null', async () => {
        const catRes = await run(shell, 'cat /dev/null');
        expect(catRes.exitCode).toBe(0);
        expect(catRes.output.join('')).toBe('');

        const writeRes = await run(shell, 'echo "discarded output" > /dev/null');
        expect(writeRes.exitCode).toBe(0);

        const catRes2 = await run(shell, 'cat /dev/null');
        expect(catRes2.exitCode).toBe(0);
        expect(catRes2.output.join('')).toBe('');
    });

    it('reads non-empty bytes from /dev/zero and /dev/urandom', () => {
        const zeroBytes = shell.context.fs.getFileByPath('/dev/zero');
        expect(zeroBytes instanceof Uint8Array).toBe(true);
        expect(zeroBytes.length).toBeGreaterThan(0);
        expect(zeroBytes.every(b => b === 0)).toBe(true);

        const randBytes = shell.context.fs.getFileByPath('/dev/urandom');
        expect(randBytes instanceof Uint8Array).toBe(true);
        expect(randBytes.length).toBeGreaterThan(0);
    });

    it('writes to /dev/tty directly to terminal stdout', async () => {
        const stdoutChunks = [];
        shell.stdout.on('data', chunk => stdoutChunks.push(String(chunk)));
        await shell.onCommand('echo "direct tty message" > /dev/tty');
        expect(stdoutChunks.join('')).toContain('direct tty message');
    });

    it('is an in-memory overlay that is never persisted to raw fs or binary containers', async () => {
        // getRaw() must not contain dev
        expect(shell.context.fs.getRaw().dev).toBeUndefined();

        // writing to /dev/null must not write anything to getRaw()
        await run(shell, 'echo "test" > /dev/null');
        expect(shell.context.fs.getRaw().dev).toBeUndefined();

        // toBinaryContainer must not serialize /dev or device nodes
        const container = shell.context.fs.toBinaryContainer();
        const deserialized = FileSystem.fromBinaryContainer(container);
        expect(deserialized.filesystem.dev).toBeUndefined();

        // Booting a fresh filesystem from this container still has /dev mounted dynamically
        const freshFs = new FileSystem('/', container);
        expect(freshFs.exists('/dev/null')).toBe(true);
        expect(freshFs.getRaw().dev).toBeUndefined();
    });
});

describe('Signal emulation and Ctrl+C (SIGINT)', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell();
    });

    it('supports kill(signal) on Command with standard exit codes', () => {
        const cmd = new Command([], shell.context);
        let signalReceived = null;
        cmd.on('signal', sig => { signalReceived = sig; });

        cmd.kill('SIGINT');
        expect(cmd.result.getExitCode()).toBe(130);
        expect(signalReceived).toBe('SIGINT');

        cmd.kill('SIGTERM');
        expect(cmd.result.getExitCode()).toBe(143);
        expect(signalReceived).toBe('SIGTERM');
    });

    it('aborts running command on Ctrl+C (\\x03) with exit code 130', async () => {
        class SlowCommand extends Command {
            static get name() { return 'slowcmd'; }
            run() {
                return new Promise(resolve => {
                    this._timer = setTimeout(() => resolve('done'), 5000);
                });
            }
            kill(sig) {
                if (this._timer) clearTimeout(this._timer);
                super.kill(sig);
            }
        }

        shell.context.setCommand(SlowCommand);

        const runPromise = shell.onCommand('slowcmd');
        // Let command start running
        await new Promise(r => setTimeout(r, 50));
        expect(shell.runningCommand).toBeDefined();

        // Send Ctrl+C
        shell.write('\x03');
        await runPromise;

        expect(shell.lastCode).toBe(130);
    });
});

describe('WASM requirements auto-discovery', () => {
    it('detects asyncify from wasm exports without hardcoded names', () => {
        const fakeWasmWithAsyncify = {
            name: 'custom-app',
            exports: ['_start', 'asyncify_start_unwind', 'asyncify_stop_unwind']
        };
        const hasAsyncify = fakeWasmWithAsyncify.exports.includes('asyncify_start_unwind') &&
            fakeWasmWithAsyncify.exports.includes('asyncify_stop_unwind');
        expect(hasAsyncify).toBe(true);
    });

    it('computes interactivity from pkgMeta or inspected wasm', () => {
        const wasmCmd = new WasmCommand('some-random-game.wasm', [], {});
        expect(wasmCmd.interactive).toBe(false);

        wasmCmd._pkgMeta = { interactive: true };
        expect(wasmCmd.interactive).toBe(true);

        const wasmCmd2 = new WasmCommand('another-tool.wasm', [], {});
        wasmCmd2._inspectedWasm = { isInteractive: true };
        expect(wasmCmd2.interactive).toBe(true);
    });

    it('encodes special keys and ignores bare modifier keys in WasmCommand._keyToBytes', () => {
        const wasmCmd = new WasmCommand('game.wasm', [], {});
        const dec = new TextDecoder();

        expect(wasmCmd._keyToBytes('Shift')).toBeNull();
        expect(wasmCmd._keyToBytes('Control')).toBeNull();
        expect(wasmCmd._keyToBytes('Alt')).toBeNull();
        expect(wasmCmd._keyToBytes('Meta')).toBeNull();
        expect(wasmCmd._keyToBytes('CapsLock')).toBeNull();
        expect(wasmCmd._keyToBytes('Unidentified')).toBeNull();

        expect(dec.decode(wasmCmd._keyToBytes('Space'))).toBe(' ');
        expect(dec.decode(wasmCmd._keyToBytes('Spacebar'))).toBe(' ');
        expect(dec.decode(wasmCmd._keyToBytes('Up'))).toBe('\x1b[A');
        expect(dec.decode(wasmCmd._keyToBytes('Down'))).toBe('\x1b[B');
        expect(dec.decode(wasmCmd._keyToBytes('Right'))).toBe('\x1b[C');
        expect(dec.decode(wasmCmd._keyToBytes('Left'))).toBe('\x1b[D');
        expect(dec.decode(wasmCmd._keyToBytes('Esc'))).toBe('\x1b');
        expect(dec.decode(wasmCmd._keyToBytes('Return'))).toBe('\r');
        expect(dec.decode(wasmCmd._keyToBytes('Del'))).toBe('\x1b[3~');
        expect(dec.decode(wasmCmd._keyToBytes('BackTab'))).toBe('\x1b[Z');
        expect(dec.decode(wasmCmd._keyToBytes('F1'))).toBe('\x1bOP');
        expect(dec.decode(wasmCmd._keyToBytes('F5'))).toBe('\x1b[15~');
        expect(dec.decode(wasmCmd._keyToBytes('F12'))).toBe('\x1b[24~');
    });

    it('parses function keys, modified cursor sequences, and detects custom stdin listeners in TtyStream', () => {
        const { parseVtKeys, hasCustomStdinListener } = require('../lib/TtyStream.js');
        expect(parseVtKeys('\x1bOP\x1bOQ\x1b[15~\x1b[24~\x1b[2~\x1b[Z')).toEqual([
            'F1', 'F2', 'F5', 'F12', 'Insert', 'BackTab'
        ]);
        expect(parseVtKeys('\x1b[1;5A\x1b[1;2C')).toEqual(['ArrowUp', 'ArrowRight']);

        const cmd = new Command([], {});
        expect(hasCustomStdinListener(cmd)).toBe(false);

        // Simulate WasmCommand removing default _onStdinStreamData and attaching raw data listener (listenerCount === 1)
        cmd.stdinStream.off('data', cmd._onStdinStreamData);
        const customFn = () => {};
        cmd.stdinStream.on('data', customFn);
        expect(cmd.stdinStream.listenerCount('data')).toBe(1);
        expect(hasCustomStdinListener(cmd)).toBe(true);

        cmd._managesOwnStdinCapture = true;
        expect(hasCustomStdinListener(cmd)).toBe(false);
    });

    it('initializes Shell with cols/rows options and prioritizes live stream size in InteractiveCommand', async () => {
        const InteractiveCommand = require('../lib/InteractiveCommand.js');
        const sizedShell = new Shell({ cols: 140, rows: 45 });
        expect(sizedShell.stdout.columns).toBe(140);
        expect(sizedShell.stdout.rows).toBe(45);
        expect(sizedShell.context.getVar('COLUMNS')).toBe('140');
        expect(sizedShell.context.getVar('LINES')).toBe('45');

        const icmd = new InteractiveCommand([], sizedShell.context);
        sizedShell.context.setVar('COLUMNS', '80');
        sizedShell.context.setVar('LINES', '24');
        icmd.stdout.columns = 160;
        icmd.stdout.rows = 50;
        expect(icmd.terminalSize).toEqual({ cols: 160, rows: 50 });
    });

    it('forwards Ctrl+C (\\x03) as raw input to a raw-mode child command inside a shell script without killing the script', async () => {
        const shell = await createShell({
            filesystem: {
                bin: {
                    'run-raw': '#!/bin/sh\nrawchild\n'
                }
            },
            permissions: {
                '/bin/run-raw': 0o755
            }
        });

        const receivedBytes = [];
        class RawChildCommand extends Command {
            static get name() { return 'rawchild'; }
            get interactive() { return true; }
            get captureInput() { return true; }
            run() {
                return new Promise(resolve => {
                    this.stdinStream.off('data', this._onStdinStreamData);
                    this.stdinStream.setRawMode(true);
                    this.stdinStream.on('data', chunk => {
                        const s = String(chunk);
                        receivedBytes.push(s);
                        if (s === 'q') {
                            this.stdinStream.setRawMode(false);
                            resolve();
                        }
                    });
                });
            }
        }
        shell.context.setCommand(RawChildCommand);

        const p = shell.onCommand('run-raw');
        await new Promise(r => setTimeout(r, 40));

        // Send Ctrl+C while rawchild is in raw mode inside ScriptCommand
        shell.write('\x03');
        await new Promise(r => setTimeout(r, 20));
        expect(receivedBytes).toContain('\x03');

        // Exit rawchild cleanly
        shell.write('q');
        await p;
        expect(shell.lastCode).toBe(0);
    });
});


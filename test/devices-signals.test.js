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
});

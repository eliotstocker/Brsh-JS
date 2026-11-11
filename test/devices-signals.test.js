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

    function buildTermiosTestWasm(initialLflag) {
        const uleb = (n) => {
            const out = [];
            do {
                let b = n & 0x7f;
                n >>>= 7;
                if (n) b |= 0x80;
                out.push(b);
            } while (n);
            return out;
        };
        const sleb = (n) => {
            const out = [];
            let more = true;
            while (more) {
                let b = n & 0x7f;
                n >>= 7;
                if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
                else b |= 0x80;
                out.push(b);
            }
            return out;
        };
        const str = (s) => {
            const b = Buffer.from(s, 'utf8');
            return [...uleb(b.length), ...b];
        };
        const sec = (id, body) => [id, ...uleb(body.length), ...body];
        const vec = (items) => [...uleb(items.length), ...items.flat()];
        const fnBody = (locals, instrs) => {
            const b = [...vec(locals), ...instrs, 0x0b];
            return [...uleb(b.length), ...b];
        };

        const types = sec(1, vec([
            [0x60, 0, 0],
            [0x60, 0, 1, 0x7f],
            [0x60, 1, 0x7f, 0],
            [0x60, 2, 0x7f, 0x7f, 0],
            [0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f],
        ]));
        const imports = sec(2, vec([
            [...str('wasi_snapshot_preview1'), ...str('clock_nanosleep'), 0x00, 4],
            [...str('wasi_snapshot_preview1'), ...str('fd_read'), 0x00, 4],
            [...str('wasi_snapshot_preview1'), ...str('fd_write'), 0x00, 4],
        ]));
        const funcs = sec(3, vec([3, 1, 2, 0, 2, 0, 1, 0]));
        const mem = sec(5, vec([[0x00, 1]]));
        const globals = sec(6, vec([
            [0x7f, 1, 0x41, ...sleb(0), 0x0b],
            [0x7f, 1, 0x41, ...sleb(initialLflag), 0x0b],
        ]));
        const exports = sec(7, vec([
            [...str('memory'), 0x02, 0],
            [...str('set_terminal_size'), 0x00, 3],
            [...str('get_termios_lflag'), 0x00, 4],
            [...str('asyncify_start_unwind'), 0x00, 5],
            [...str('asyncify_stop_unwind'), 0x00, 6],
            [...str('asyncify_start_rewind'), 0x00, 7],
            [...str('asyncify_stop_rewind'), 0x00, 8],
            [...str('asyncify_get_state'), 0x00, 9],
            [...str('_start'), 0x00, 10],
        ]));

        const startInstrs = initialLflag === 1
            ? [
                0x41, ...sleb(256), 0x42, ...sleb(5000000000), 0x37, 3, 0,
                0x41, 0, 0x41, 0, 0x41, ...sleb(256), 0x41, ...sleb(264), 0x10, 0, 0x1a
            ]
            : [
                0x03, 0x40,
                    0x41, ...sleb(128), 0x41, ...sleb(160), 0x36, 2, 0,
                    0x41, ...sleb(132), 0x41, 1, 0x36, 2, 0,
                    0x41, 0, 0x41, ...sleb(128), 0x41, 1, 0x41, ...sleb(136), 0x10, 1, 0x1a,
                    0x23, 0, 0x41, 1, 0x46, 0x04, 0x40, 0x0f, 0x0b,
                    0x41, ...sleb(160), 0x2d, 0, 0, 0x21, 0,
                    0x20, 0, 0x41, 0x18, 0x46, 0x04, 0x40, 0x0f, 0x0b,
                    0x20, 0, 0x41, ...sleb(0x73), 0x46, 0x04, 0x40, 0x41, 1, 0x24, 1, 0x0b,
                    0x20, 0, 0x41, 3, 0x46, 0x04, 0x40,
                        0x41, ...sleb(300), 0x41, ...sleb(0x585445), 0x36, 2, 0,
                        0x41, ...sleb(140), 0x41, ...sleb(300), 0x36, 2, 0,
                        0x41, ...sleb(144), 0x41, 3, 0x36, 2, 0,
                        0x41, 1, 0x41, ...sleb(140), 0x41, 1, 0x41, ...sleb(148), 0x10, 2, 0x1a,
                    0x0b,
                    0x0c, 0,
                0x0b
            ];

        const code = sec(10, vec([
            fnBody([], []),
            fnBody([], [0x23, 1]),
            fnBody([], [0x41, 1, 0x24, 0]),
            fnBody([], [0x41, 0, 0x24, 0]),
            fnBody([], [0x41, 2, 0x24, 0]),
            fnBody([], [0x41, 0, 0x24, 0]),
            fnBody([], [0x23, 0]),
            fnBody([[1, 0x7f]], startInstrs),
        ]));

        return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...types, ...imports, ...funcs, ...mem, ...globals, ...exports, ...code]);
    }

    it('terminates cbreak WASM command (ISIG enabled) on Ctrl+C immediately, restores screen, and aborts parent launcher script', async () => {
        const cbreakWasm = buildTermiosTestWasm(1);
        const shell = await createShell({
            filesystem: {
                bin: {
                    'cbreak-game': cbreakWasm,
                    'launch-game': '#!/bin/sh\ncbreak-game\necho "AFTER_GAME" > /after.txt\n'
                }
            },
            permissions: {
                '/bin/cbreak-game': 0o755,
                '/bin/launch-game': 0o755
            }
        });

        // 1. Direct WASM execution: Ctrl+C via stream write (\x03) cancels 5s clock_nanosleep immediately
        const out1 = [];
        const onOut1 = c => out1.push(String(c));
        shell.stdout.on('data', onOut1);

        const t0 = Date.now();
        const p1 = shell.onCommand('cbreak-game');
        await new Promise(r => setTimeout(r, 30));

        shell.write('\x03');
        await p1;
        const elapsed = Date.now() - t0;
        shell.stdout.off('data', onOut1);

        expect(shell.lastCode).toBe(130);
        expect(elapsed).toBeLessThan(1000);
        expect(out1.join('')).toContain('\x1b[?1049h');
        expect(out1.join('')).toContain('\x1b[?1049l');
        expect(out1.join('')).not.toContain('^C\r\n');

        // 2. Via shell script wrapper (like freedoom): Ctrl+C kills child + script without running subsequent lines
        const p2 = shell.onCommand('launch-game');
        await new Promise(r => setTimeout(r, 40));

        shell.write('\x03');
        await p2;

        expect(shell.lastCode).toBe(130);
        expect(shell.context.fs.exists('/after.txt')).toBe(false);

        // 3. Ctrl+C via shell.onInput('^C') also delivers SIGINT cleanly
        const p3 = shell.onCommand('cbreak-game');
        await new Promise(r => setTimeout(r, 30));
        shell.onInput('^C');
        await p3;
        expect(shell.lastCode).toBe(130);
    });

    it('passes Ctrl+C (\\x03) as raw input when WASM clears ISIG (~ISIG) and honors dynamic ISIG re-enablement', async () => {
        const rawWasm = buildTermiosTestWasm(0);
        const shell = await createShell({
            filesystem: {
                bin: {
                    'raw-editor': rawWasm
                }
            },
            permissions: {
                '/bin/raw-editor': 0o755
            }
        });

        const chunks = [];
        const onData = c => chunks.push(String(c));
        shell.stdout.on('data', onData);

        const p = shell.onCommand('raw-editor');
        await new Promise(r => setTimeout(r, 30));

        // While lflag == 0 (~ISIG), Ctrl+C is delivered as byte 0x03 ("ETX" written to stdout)
        shell.write('\x03');
        await new Promise(r => setTimeout(r, 30));
        expect(chunks.join('')).toContain('ETX');
        expect(shell.runningCommand).toBeDefined();

        // Sending 's' toggles lflag to 1 (re-enabling ISIG dynamically at runtime)
        shell.write('s');
        await new Promise(r => setTimeout(r, 20));

        // Subsequent Ctrl+C now terminates with SIGINT (130)
        shell.write('\x03');
        await p;
        shell.stdout.off('data', onData);

        expect(shell.lastCode).toBe(130);
    });
});



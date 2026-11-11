import { describe, it, expect } from 'vitest';
import Shell from '../index.js';
import { run } from './helpers.js';

// Minimal valid WASM binary that exports _start and exits with 0:
const MINIMAL_WASM_BYTES = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b
]);

describe('Running .wasm files directly as CLI tools in base shell', () => {
    it('refuses to execute a .wasm file without execute permissions (permission denied)', async () => {
        const shell = new Shell({
            filesystem: {
                home: {
                    'mytool.wasm': MINIMAL_WASM_BYTES
                }
            },
            cwd: '/home'
        });

        // Default mode is 0o644 -> not executable
        const res = await run(shell, './mytool.wasm');
        expect(res.exitCode).toBe(1);
        expect(res.errors.join('')).toContain('permission denied');
    });

    it('executes a .wasm file via ./mytool.wasm after chmod +x', async () => {
        const shell = new Shell({
            filesystem: {
                home: {
                    'mytool.wasm': MINIMAL_WASM_BYTES
                }
            },
            cwd: '/home'
        });

        await run(shell, 'chmod +x mytool.wasm');
        const res = await run(shell, './mytool.wasm');
        expect(res.exitCode).toBe(0);
    });

    it('refuses to run a file in cwd by bare name without path (standard PATH behavior)', async () => {
        const shell = new Shell({
            filesystem: {
                home: {
                    'mytool.wasm': MINIMAL_WASM_BYTES
                }
            },
            permissions: {
                '/home/mytool.wasm': 0o755
            },
            cwd: '/home'
        });

        const res = await run(shell, 'mytool.wasm');
        expect(res.exitCode).toBe(1);
        expect(res.errors.join('')).toContain('Command not found');
    });

    it('executes an executable .wasm file placed in /bin by bare name without .wasm extension', async () => {
        const shell = new Shell({
            filesystem: {
                bin: {
                    'cowsay.wasm': MINIMAL_WASM_BYTES
                }
            },
            permissions: {
                '/bin/cowsay.wasm': 0o755
            }
        });

        const res = await run(shell, 'cowsay');
        expect(res.exitCode).toBe(0);
    });

    it('supports --help and --version automatically on raw .wasm binaries', async () => {
        const shell = new Shell({
            filesystem: {
                home: {
                    'mytool.wasm': MINIMAL_WASM_BYTES
                }
            },
            permissions: {
                '/home/mytool.wasm': 0o755
            },
            cwd: '/home'
        });

        const helpRes = await run(shell, './mytool.wasm --help');
        expect(helpRes.exitCode).toBe(0);
        const helpText = helpRes.output.join('\n');
        expect(helpText).toContain('Usage: mytool.wasm');
        expect(helpText).toContain('-h, --help');
        expect(helpText).toContain('-V, --version');
        expect(helpText).toContain('WASM Exports: _start');

        const verRes = await run(shell, './mytool.wasm --version');
        expect(verRes.exitCode).toBe(0);
        expect(verRes.output.join('\n')).toContain('mytool.wasm');
    });

    it('supports piping stdin into .wasm binaries and redirecting stdout to files', async () => {
        const shell = new Shell({
            filesystem: {
                bin: {
                    'mytool.wasm': MINIMAL_WASM_BYTES
                }
            },
            permissions: {
                '/bin/mytool.wasm': 0o755
            }
        });

        const pipeRes = await run(shell, 'echo "input data" | mytool');
        expect(pipeRes.exitCode).toBe(0);

        const redirRes = await run(shell, 'mytool --help > /help.txt');
        expect(redirRes.exitCode).toBe(0);
        expect(shell.context.fs.exists('/help.txt')).toBe(true);
        expect(shell.context.fs.getFileByPath('/help.txt')).toContain('Usage: mytool.wasm');
    });

    it('supports WASI fd_fdstat_set_flags, fd_fdstat_get, and non-blocking fd_read (ERRNO_AGAIN)', async () => {
        const NONBLOCK_WASM_BYTES = Buffer.from(
            'AGFzbQEAAAABFgRgAn9/AX9gAX8AYAR/f39/AX9gAAACmQEEFndhc2lfc25hcHNob3RfcHJldmlldzETZmRfZmRzdGF0X3NldF9mbGFncwAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQ1mZF9mZHN0YXRfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9yZWFkAAIDAgEDBQMBAAIGCAF/AUGQigQLBxMCBm1lbW9yeQIABl9zdGFydAAECt4BAdsBAQF/I4CAgIAAQRBrIgAkgICAgAACQEEAQQQQgICAgABFDQBBChCBgICAAAsCQEEAQZCIgIAAEIKAgIAARQ0AQQsQgYCAgAALAkBBAC8BkoiAgABBBEYNAEEMEIGAgIAACyAAQQApA4CIgIAANwMIIABBADYCBAJAQQAgAEEIakEBIABBBGoQg4CAgABBBkYNAEENEIGAgIAACwJAQQJBBBCAgICAAEUNAEEOEIGAgIAAC0ECIABBCGpBASAAQQRqEIOAgIAAGkEAEIGAgIAAIABBEGokgICAgAALCw8BAEGACAsIMAQAABAAAAAAaARuYW1lAUEFABNmZF9mZHN0YXRfc2V0X2ZsYWdzAQlwcm9jX2V4aXQCDWZkX2Zkc3RhdF9nZXQDB2ZkX3JlYWQEBl9zdGFydAcSAQAPX19zdGFja19wb2ludGVyCQoBAAcucm9kYXRhAC0JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDERlYmlhbiBjbGFuZwYxNC4wLjY=',
            'base64'
        );

        const shell = new Shell({
            filesystem: {
                bin: {
                    'nonblock.wasm': NONBLOCK_WASM_BYTES
                }
            },
            permissions: {
                '/bin/nonblock.wasm': 0o755
            }
        });

        const res = await run(shell, 'nonblock');
        expect(res.exitCode).toBe(0);
    });

    it('supports WASI poll_oneoff clock subscriptions and timers', async () => {
        const POLL_WASM_BYTES = Buffer.from(
            'AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACSQIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQtwb2xsX29uZW9mZgAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAIGCAF/AUGAiAQLBxMCBm1lbW9yeQIABl9zdGFydAACCtABAc0BAQN/I4CAgIAAQeAAayIAJICAgIAAIABB2ABqIgFCADcDACAAQTBqQRBqIgJCADcDACAAQdAAakIANwMAIAFBADsBACACQQA2AgAgAEIANwM4IABCgK3iBDcDSCAAQrngADcDMCAAQShqQgA3AwAgAEEQakEQakIANwMAIABBGGpCADcDACAAQgA3AxAgAEEANgIMAkAgAEEwaiAAQRBqQQEgAEEMahCAgICAAEUNAEEUEIGAgIAAC0EAEIGAgIAAIABB4ABqJICAgIAACwA8BG5hbWUBIQMAC3BvbGxfb25lb2ZmAQlwcm9jX2V4aXQCBl9zdGFydAcSAQAPX19zdGFja19wb2ludGVyAC0JcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDERlYmlhbiBjbGFuZwYxNC4wLjY=',
            'base64'
        );

        const shell = new Shell({
            filesystem: {
                bin: {
                    'poll.wasm': POLL_WASM_BYTES
                }
            },
            permissions: {
                '/bin/poll.wasm': 0o755
            }
        });

        const res = await run(shell, 'poll');
        expect(res.exitCode).toBe(0);
    });

    it('supports opening /dev/null, /dev/zero, and exporting set_terminal_size for dynamic sizing', async () => {
        const DEV_WASM_BYTES = Buffer.from(
            'AGFzbQEAAAABKwdgCX9/f39/fn5/fwF/YAF/AGAEf39/fwF/YAF/AX9gAn9/AGAAAX9gAAACrAEFFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQdmZF9yZWFkAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF9jbG9zZQADAwUEBAUFBgQFAXABAQEFAwEAAgYIAX8BQbCIBAsHPQUGbWVtb3J5AgARc2V0X3Rlcm1pbmFsX3NpemUABQhnZXRfY29scwAGCGdldF9yb3dzAAcGX3N0YXJ0AAgKgwQEGABBACABNgKkiICAAEEAIAA2AqCIgIAACwsAQQAoAqCIgIAACwsAQQAoAqSIgIAAC88DAQF/I4CAgIAAQfAAayIAJICAgIAAIABB6ABqQQAvAJKIgIAAOwEAIABBACkAioiAgAA3A2ACQEEDQQAgAEHgAGpBCUEAQgBCAEEAIABB7ABqEICAgIAARQ0AQQoQgYCAgAALIABBACgAm4iAgAA2AFcgAEEAKQCUiICAADcDUCAAQQo2AkwgACAAQdAAajYCSCAAQQA2AkQCQAJAIAAoAmwgAEHIAGpBASAAQcQAahCCgICAAA0AIAAoAkRBCkYNAQtBCxCBgICAAAsgAEEgNgIcIAAgAEEgajYCGCAAQeMANgIUAkACQCAAKAJsIABBGGpBASAAQRRqEIOAgIAADQAgACgCFEUNAQtBDBCBgICAAAsgACgCbBCEgICAABogAEEIakEALwCIiICAADsBACAAQQApAICIgIAANwMAAkBBA0EAIABBCUEAQgBCAEEAIABBEGoQgICAgABFDQBBDRCBgICAAAsgAEHV1AI7ASACQAJAIAAoAhAgAEEYakEBIABBFGoQg4CAgAANACAALQAgQf8BcQ0AIAAtACFB/wFxRQ0BC0EOEIGAgIAACyAAKAIQEISAgIAAGkEAEIGAgIAAIABB8ABqJICAgIAACwsmAQBBgAgLHy9kZXYvemVybwAvZGV2L251bGwAaGVsbG8gbnVsbAAArgEEbmFtZQGGAQkAEF9fd2FzaV9wYXRoX29wZW4BEF9fd2FzaV9wcm9jX2V4aXQCD19fd2FzaV9mZF93cml0ZQMOX193YXNpX2ZkX3JlYWQED19fd2FzaV9mZF9jbG9zZQURc2V0X3Rlcm1pbmFsX3NpemUGCGdldF9jb2xzBwhnZXRfcm93cwgGX3N0YXJ0BxIBAA9fX3N0YWNrX3BvaW50ZXIJCgEABy5yb2RhdGEALQlwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEMRGViaWFuIGNsYW5nBjE0LjAuNg==',
            'base64'
        );

        const shell = new Shell({
            filesystem: {
                bin: {
                    'devtool.wasm': DEV_WASM_BYTES
                }
            },
            permissions: {
                '/bin/devtool.wasm': 0o755
            }
        });

        const res = await run(shell, 'devtool');
        expect(res.exitCode).toBe(0);
    });

    it('passes live stdout COLUMNS and LINES to WASI environ_get over stale context vars', async () => {
        // WASI binary that reads environ_sizes_get + environ_get and writes the environment block to stdout
        const ENV_DUMP_WASM_BYTES = Buffer.from(
            'AGFzbQEAAAABEgNgAn9/AX9gBH9/f38Bf2AAAAJzAxZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxEWVudmlyb25fc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQtlbnZpcm9uX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfd3JpdGUAAQMCAQIFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQAAwowAS4AQQBBBBAAGkEQQYAEEAEaQQhBgAQ2AgBBDEEEKAIANgIAQQFBCEEBQQAQAhoL',
            'base64'
        );

        const shell = new Shell({
            filesystem: {
                bin: { 'envdump.wasm': ENV_DUMP_WASM_BYTES }
            },
            permissions: {
                '/bin/envdump.wasm': 0o755
            }
        });

        // Simulate stale 80x24 context vars while live stream dimensions are 132x42
        shell.context.setVar('COLUMNS', '80');
        shell.context.setVar('LINES', '24');
        shell.stdout.columns = 132;
        shell.stdout.rows = 42;
        shell.stdin.columns = 132;
        shell.stdin.rows = 42;

        const res = await run(shell, 'envdump');
        expect(res.exitCode).toBe(0);
        const rawEnv = res.output.join('\n').replace(/\0/g, '\n');
        expect(rawEnv).toContain('COLUMNS=132');
        expect(rawEnv).toContain('LINES=42');
        expect(rawEnv).not.toContain('COLUMNS=80');
        expect(rawEnv).not.toContain('LINES=24');
    });

    it('delivers stdin via hasCustomStdinListener and distinguishes poll_oneoff timeout from FD_READ', async () => {
        // Asyncify WASI binary polling FD_READ (type=1) + CLOCK 35ms (type=0) and printing "<nevents>:<event0.type>\n"
        const ASYNC_POLL_WASM_BYTES = Buffer.from(
            'AGFzbQEAAAABFARgBH9/f38Bf2ABfwBgAABgAAF/AkgCFndhc2lfc25hcHNob3RfcHJldmlldzELcG9sbF9vbmVvZmYAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxCGZkX3dyaXRlAAADBwYBAgECAwIFAwEAAgYGAX8BQQALB4YBBwZtZW1vcnkCABVhc3luY2lmeV9zdGFydF91bndpbmQAAhRhc3luY2lmeV9zdG9wX3Vud2luZAADFWFzeW5jaWZ5X3N0YXJ0X3Jld2luZAAEFGFzeW5jaWZ5X3N0b3BfcmV3aW5kAAUSYXN5bmNpZnlfZ2V0X3N0YXRlAAYGX3N0YXJ0AAcK1AEGBgBBASQACwYAQQAkAAsGAEECJAALBgBBACQACwQAIwALsAEAQcAAQgs3AwBByABBAToAAEHQAEEANgIAQfAAQhY3AwBB+ABBADoAAEGAAUEBNgIAQYgBQsCd2BA3AwBBmAFBADsBAEHKAUEJOgAAQcAAQcABQQJBmAIQABojAEEBRgRADwtBrAJBMEGYAigCAGo6AABBrQJBOjoAAEGuAkEwQcoBLQAAajoAAEGvAkEKOgAAQcACQawCNgIAQcQCQQQ2AgBBAUHAAkEBQcgCEAEaCw==',
            'base64'
        );

        const shell = new Shell({
            filesystem: {
                bin: { 'asyncpoll.wasm': ASYNC_POLL_WASM_BYTES }
            },
            permissions: {
                '/bin/asyncpoll.wasm': 0o755
            }
        });

        // 1. No input sent -> clock timeout fires ONLY clock event ("1:0"), NOT false FD_READ
        const rawOut1 = [];
        const onRaw1 = (chunk) => rawOut1.push(String(chunk));
        shell.stdout.on('data', onRaw1);
        const timeoutRes = await run(shell, 'asyncpoll');
        shell.stdout.off('data', onRaw1);
        expect(timeoutRes.exitCode).toBe(0);
        const text1 = rawOut1.join('') + timeoutRes.output.join('');
        expect(text1).toContain('1:0');
        expect(text1).not.toContain('1:1');

        // 2. Input written while WASM is polling -> delivered via hasCustomStdinListener, wakes FD_READ ("1:1")
        const rawOut2 = [];
        const onRaw2 = (chunk) => rawOut2.push(String(chunk));
        shell.stdout.on('data', onRaw2);
        const cmdPromise = shell.onCommand('asyncpoll');
        await new Promise(r => setTimeout(r, 10));
        shell.write('k');
        await cmdPromise;
        shell.stdout.off('data', onRaw2);
        expect(shell.lastCode).toBe(0);
        const text2 = rawOut2.join('');
        expect(text2).toContain('1:1');
        expect(text2).not.toContain('1:0');
    });
});



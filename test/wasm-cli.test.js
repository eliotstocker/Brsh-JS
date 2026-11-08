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
});

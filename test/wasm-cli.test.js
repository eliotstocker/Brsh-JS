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

// Minimal WASM module builder for testing specific WASI syscalls without external compilers
function uleb(n) {
    const out = [];
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return out;
}

function sleb(n) {
    let v = BigInt(n);
    const out = [];
    while (true) {
        let b = Number(v & 0x7fn);
        v >>= 7n;
        const done = (v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0);
        if (!done) b |= 0x80;
        out.push(b);
        if (done) break;
    }
    return out;
}

function wasmStr(s) {
    const b = new TextEncoder().encode(s);
    return [...uleb(b.length), ...b];
}

function wasmSec(id, body) {
    return [id, ...uleb(body.length), ...body];
}

function buildWasiTestModule({ types, imports, locals = [], code, data = [] }) {
    const startTypeIdx = types.length;
    const allTypes = [...types, [[], []]];
    const typeBody = [
        ...uleb(allTypes.length),
        ...allTypes.flatMap(([params, res]) => [0x60, ...uleb(params.length), ...params, ...uleb(res.length), ...res])
    ];
    const impBody = [
        ...uleb(imports.length),
        ...imports.flatMap(([mod, name, typeIdx]) => [...wasmStr(mod), ...wasmStr(name), 0x00, ...uleb(typeIdx)])
    ];
    const funcBody = [...uleb(1), ...uleb(startTypeIdx)];
    const memBody = [...uleb(1), 0x00, 0x01];
    const expBody = [
        ...uleb(2),
        ...wasmStr('memory'), 0x02, 0x00,
        ...wasmStr('_start'), 0x00, ...uleb(imports.length)
    ];
    const localDecls = locals.length
        ? [...uleb(locals.length), ...locals.flatMap(([cnt, t]) => [...uleb(cnt), t])]
        : [0x00];
    const fnBytes = [...localDecls, ...code, 0x0b];
    const codeBody = [...uleb(1), ...uleb(fnBytes.length), ...fnBytes];
    const dataBody = data.length
        ? [...uleb(data.length), ...data.flatMap(([off, bytes]) => [0x00, 0x41, ...sleb(off), 0x0b, ...uleb(bytes.length), ...bytes])]
        : null;

    return new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ...wasmSec(1, typeBody),
        ...wasmSec(2, impBody),
        ...wasmSec(3, funcBody),
        ...wasmSec(5, memBody),
        ...wasmSec(7, expBody),
        ...wasmSec(10, codeBody),
        ...(dataBody ? wasmSec(11, dataBody) : [])
    ]);
}

describe('WASI syscalls (fd_filestat_set_size, fd_readdir, default HOME)', () => {
    const I32 = 0x7f;
    const I64 = 0x7e;

    it('truncates files cleanly with fd_filestat_set_size without leaving trailing bytes', async () => {
        const truncWasm = buildWasiTestModule({
            types: [
                [[I32, I32, I32, I32, I32, I64, I64, I32, I32], [I32]], // path_open
                [[I32, I64], [I32]], // fd_filestat_set_size
                [[I32], [I32]] // fd_close
            ],
            imports: [
                ['wasi_snapshot_preview1', 'path_open', 0],
                ['wasi_snapshot_preview1', 'fd_filestat_set_size', 1],
                ['wasi_snapshot_preview1', 'fd_close', 2]
            ],
            code: [
                0x41, 4, 0x41, 1, 0x41, 0, 0x41, 8, 0x41, 0, 0x42, 0, 0x42, 0, 0x41, 0, 0x41, ...sleb(64), 0x10, 0, 0x1a,
                0x41, ...sleb(64), 0x28, 0x02, 0x00, 0x42, 5, 0x10, 1, 0x1a,
                0x41, ...sleb(64), 0x28, 0x02, 0x00, 0x10, 2, 0x1a
            ],
            data: [[0, [...new TextEncoder().encode('data.txt')]]]
        });

        const shell = new Shell({
            filesystem: {
                home: {
                    'data.txt': 'Hello, World!',
                    'trunc.wasm': truncWasm
                }
            },
            permissions: { '/home/trunc.wasm': 0o755 },
            cwd: '/home'
        });
        await shell.ready;

        const res = await run(shell, './trunc.wasm');
        expect(res.exitCode).toBe(0);
        expect(shell.context.fs.getFileByPath('/home/data.txt')).toBe('Hello');
    });

    it('reads directory entries via fd_readdir including ., .., and files without memory out-of-bounds', async () => {
        const readdirWasm = buildWasiTestModule({
            types: [
                [[I32, I32, I32, I64, I32], [I32]], // fd_readdir
                [[I32, I32, I32, I32], [I32]] // fd_write
            ],
            imports: [
                ['wasi_snapshot_preview1', 'fd_readdir', 0],
                ['wasi_snapshot_preview1', 'fd_write', 1]
            ],
            locals: [[3, I32]], // 0: pos, 1: end, 2: namlen
            code: [
                // Read with a small 28-byte buffer at cookie=0 to verify partial record fills buf_len without OOB, then read from cookie=1
                0x41, 4, 0x41, ...sleb(1024), 0x41, 28, 0x42, 0, 0x41, 20, 0x10, 0, 0x1a,
                // Read full directory into [256..768] from cookie=0
                0x41, 4, 0x41, ...sleb(256), 0x41, ...sleb(512), 0x42, 0, 0x41, 16, 0x10, 0, 0x1a,
                0x41, ...sleb(256), 0x21, 0,
                0x41, ...sleb(256), 0x41, 16, 0x28, 0x02, 0x00, 0x6a, 0x21, 1,
                0x02, 0x40, 0x03, 0x40,
                    0x20, 0, 0x41, 24, 0x6a, 0x20, 1, 0x4b, 0x0d, 1,
                    0x20, 0, 0x28, 0x02, 16, 0x21, 2,
                    0x20, 0, 0x41, 24, 0x6a, 0x20, 2, 0x6a, 0x20, 1, 0x4b, 0x0d, 1,
                    0x41, 0, 0x20, 0, 0x41, 24, 0x6a, 0x36, 0x02, 0,
                    0x41, 4, 0x20, 2, 0x36, 0x02, 0,
                    0x41, 8, 0x41, 32, 0x36, 0x02, 0,
                    0x41, 12, 0x41, 1, 0x36, 0x02, 0,
                    0x41, 1, 0x41, 0, 0x41, 2, 0x41, 24, 0x10, 1, 0x1a,
                    0x20, 0, 0x41, 24, 0x6a, 0x20, 2, 0x6a, 0x21, 0,
                    0x0c, 0,
                0x0b, 0x0b
            ],
            data: [[32, [0x0a]]]
        });

        const shell = new Shell({
            filesystem: {
                home: {
                    'alpha.txt': 'a',
                    'beta.txt': 'b',
                    'readdir.wasm': readdirWasm
                }
            },
            permissions: { '/home/readdir.wasm': 0o755 },
            cwd: '/home'
        });
        await shell.ready;

        const res = await run(shell, './readdir.wasm');
        expect(res.exitCode).toBe(0);
        expect(res.errors).toEqual([]);
        expect(res.output).toEqual(['.', '..', 'alpha.txt', 'beta.txt', 'readdir.wasm']);
    });

    it('injects default HOME environment variable and respects explicit HOME override', async () => {
        const envWasm = buildWasiTestModule({
            types: [
                [[I32, I32], [I32]], // environ_sizes_get, environ_get
                [[I32, I32, I32, I32], [I32]] // fd_write
            ],
            imports: [
                ['wasi_snapshot_preview1', 'environ_sizes_get', 0],
                ['wasi_snapshot_preview1', 'environ_get', 0],
                ['wasi_snapshot_preview1', 'fd_write', 1]
            ],
            code: [
                0x41, 0, 0x41, 4, 0x10, 0, 0x1a,
                0x41, ...sleb(64), 0x41, ...sleb(512), 0x10, 1, 0x1a,
                0x41, 16, 0x41, ...sleb(512), 0x36, 0x02, 0,
                0x41, 20, 0x41, 4, 0x28, 0x02, 0, 0x36, 0x02, 0,
                0x41, 1, 0x41, 16, 0x41, 1, 0x41, 24, 0x10, 2, 0x1a
            ]
        });

        const shellHome = new Shell({
            filesystem: { home: { 'env.wasm': envWasm } },
            permissions: { '/home/env.wasm': 0o755 },
            cwd: '/home'
        });
        await shellHome.ready;

        const defaultRes = await run(shellHome, './env.wasm');
        expect(defaultRes.exitCode).toBe(0);
        expect(defaultRes.output.join('\n')).toContain('HOME=/home');

        await run(shellHome, 'export HOME=/custom/user');
        const overrideRes = await run(shellHome, './env.wasm');
        expect(overrideRes.exitCode).toBe(0);
        expect(overrideRes.output.join('\n')).toContain('HOME=/custom/user');

        const shellRoot = new Shell({
            filesystem: { root: { 'env.wasm': envWasm }, home: {} },
            permissions: { '/root/env.wasm': 0o755 },
            cwd: '/root'
        });
        await shellRoot.ready;

        const rootRes = await run(shellRoot, './env.wasm');
        expect(rootRes.exitCode).toBe(0);
        expect(rootRes.output.join('\n')).toContain('HOME=/root');
    });
});

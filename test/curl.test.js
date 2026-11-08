import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShell, run } from './helpers.js';
import { BinaryFile } from '../lib/FileSystem.js';

describe('curl command', () => {
    let shell;
    let originalFetch;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {}
            }
        });
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('fetches text and prints to stdout', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: async () => 'Hello, world!\nLine 2',
            arrayBuffer: async () => new TextEncoder().encode('Hello, world!\nLine 2').buffer
        });

        const res = await run(shell, 'curl https://example.com/hello.txt');
        expect(res.exitCode).toBe(0);
        expect(res.output).toEqual(['Hello, world!', 'Line 2']);
    });

    it('includes response headers with -i', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({
                'content-type': 'text/plain',
                'x-custom-header': 'test-val'
            }),
            text: async () => 'response body',
            arrayBuffer: async () => new TextEncoder().encode('response body').buffer
        });

        const res = await run(shell, 'curl -i https://example.com');
        expect(res.exitCode).toBe(0);
        expect(res.output).toContain('HTTP/1.1 200 OK');
        expect(res.output).toContain('x-custom-header: test-val');
        expect(res.output).toContain('response body');
    });

    it('downloads binary data to a file without UTF-8 corruption', async () => {
        // Raw bytes with non-UTF8 sequences (e.g. WASM or GGUF magic headers)
        const binaryBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80]);

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({
                'content-type': 'application/octet-stream',
                'content-length': String(binaryBytes.length)
            }),
            arrayBuffer: async () => binaryBytes.buffer
        });

        const res = await run(shell, 'curl -s -o /home/model.wasm https://example.com/model.wasm');
        expect(res.exitCode).toBe(0);

        const savedFile = shell.context.fs.getFileByPath('/home/model.wasm');
        expect(savedFile).toBeDefined();
        expect(savedFile instanceof BinaryFile || savedFile instanceof Uint8Array).toBe(true);
        expect(new Uint8Array(savedFile)).toEqual(binaryBytes);
    });

    it('emits live carriage return progress bar during streaming download to a file', async () => {
        const chunk1 = new Uint8Array([1, 2, 3, 4, 5]);
        const chunk2 = new Uint8Array([6, 7, 8, 9, 10]);
        let readCount = 0;

        const mockReader = {
            read: vi.fn().mockImplementation(async () => {
                readCount++;
                if (readCount === 1) return { done: false, value: chunk1 };
                if (readCount === 2) return { done: false, value: chunk2 };
                return { done: true, value: undefined };
            })
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({
                'content-type': 'application/octet-stream',
                'content-length': '10'
            }),
            body: {
                getReader: () => mockReader
            }
        });

        const res = await run(shell, 'curl -o /home/stream.bin https://example.com/stream.bin');
        expect(res.exitCode).toBe(0);

        // Verify progress updates with \r were emitted
        const progressLines = res.output.filter(l => l.startsWith('\r'));
        expect(progressLines.length).toBeGreaterThan(0);
        expect(progressLines.some(l => l.includes('50%'))).toBe(true);
        expect(progressLines.some(l => l.includes('100%'))).toBe(true);

        const savedFile = shell.context.fs.getFileByPath('/home/stream.bin');
        expect(new Uint8Array(savedFile)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    });

    it('suppresses progress bar when -s / --silent is passed', async () => {
        const chunk = new Uint8Array([1, 2, 3, 4, 5]);
        let done = false;

        const mockReader = {
            read: vi.fn().mockImplementation(async () => {
                if (!done) {
                    done = true;
                    return { done: false, value: chunk };
                }
                return { done: true, value: undefined };
            })
        };

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({
                'content-type': 'application/octet-stream',
                'content-length': '5'
            }),
            body: {
                getReader: () => mockReader
            }
        });

        const res = await run(shell, 'curl -s -o /home/quiet.bin https://example.com/quiet.bin');
        expect(res.exitCode).toBe(0);
        expect(res.output.some(l => l.startsWith('\r'))).toBe(false);
    });

    it('automatically creates parent directories for output files', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'text/plain' }),
            arrayBuffer: async () => new TextEncoder().encode('nested data').buffer
        });

        const res = await run(shell, 'curl -s -o /home/nested/sub/dir/app.txt https://example.com/app.txt');
        expect(res.exitCode).toBe(0);
        expect(shell.context.fs.getFileByPath('/home/nested/sub/dir/app.txt')).toBe('nested data');
    });
});

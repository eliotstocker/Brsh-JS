import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
const Shell = require('../index.js');
const FileSystem = require('../lib/FileSystem.js');
const { BinaryFile, SymlinkRef } = require('../lib/FileSystem.js');

// Small 1x1 red PNG (base64)
const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
const RED_PNG_DATA_URI = `data:image/png;base64,${RED_PNG_B64}`;

// Helper: create BinaryFile from base64 without Buffer pool issues
function binaryFileFromB64(b64, mime) {
    const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    return new BinaryFile(bytes.buffer, mime);
}

describe('BinaryFile class', () => {
    it('is a subclass of Uint8Array', () => {
        const bf = binaryFileFromB64(RED_PNG_B64, 'image/png');
        expect(bf instanceof Uint8Array).toBe(true);
        expect(bf instanceof BinaryFile).toBe(true);
    });

    it('stores mimeType as non-enumerable property', () => {
        const bf = binaryFileFromB64(RED_PNG_B64, 'image/png');
        expect(bf.mimeType).toBe('image/png');
        expect(Object.keys(bf)).not.toContain('mimeType');
    });

    it('toString() reconstructs the original data URI', () => {
        const bf = binaryFileFromB64(RED_PNG_B64, 'image/png');
        expect(bf.toString()).toBe(RED_PNG_DATA_URI);
    });

    it('has the correct byte length', () => {
        const bf = binaryFileFromB64(RED_PNG_B64, 'image/png');
        const expectedLen = Buffer.from(RED_PNG_B64, 'base64').length;
        expect(bf.length).toBe(expectedLen);
    });
});

describe('FileSystem binary conversion', () => {
    it('converts data URI strings to BinaryFile on construction', () => {
        const fs = new FileSystem('/', { img: RED_PNG_DATA_URI });
        const file = fs.getFileByPath('/img');
        expect(file instanceof BinaryFile).toBe(true);
    });

    it('does not modify non-data-URI strings', () => {
        const fs = new FileSystem('/', { readme: 'hello world' });
        const file = fs.getFileByPath('/readme');
        expect(typeof file).toBe('string');
        expect(file).toBe('hello world');
    });

    it('recurses into subdirectories', () => {
        const fs = new FileSystem('/', { subdir: { img: RED_PNG_DATA_URI } });
        const file = fs.getFileByPath('/subdir/img');
        expect(file instanceof BinaryFile).toBe(true);
    });

    it('stat() reports isBinary:true for converted images', () => {
        const fs = new FileSystem('/', { img: RED_PNG_DATA_URI });
        const s = fs.stat('/img');
        expect(s.isFile).toBe(true);
        expect(s.isBinary).toBe(true);
        expect(s.isDirectory).toBe(false);
        expect(s.isCommand).toBe(false);
    });

    it('stat() reports isBinary:false for text files', () => {
        const fs = new FileSystem('/', { readme: 'hello' });
        const s = fs.stat('/readme');
        expect(s.isFile).toBe(true);
        expect(s.isBinary).toBe(false);
    });

    it('getSize() returns byte count for binary files', () => {
        const fs = new FileSystem('/', { img: RED_PNG_DATA_URI });
        const bytes = Buffer.from(RED_PNG_B64, 'base64');
        expect(fs.getSize('/img')).toBe(bytes.length);
    });

    it('BinaryFile toString() is backward-compatible via cat', async () => {
        const shell = await createShell({ filesystem: { img: RED_PNG_DATA_URI } });
        const { output } = await run(shell, 'cat /img');
        expect(output.join('')).toBe(RED_PNG_DATA_URI);
    });
});

describe('FileSystem virtual symlinks', () => {
    it('createSymlink stores a SymlinkRef', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        fs.createSymlink('/file', '/link');
        const raw = fs._getFileByAbsolutePath('/link');
        expect(raw instanceof SymlinkRef).toBe(true);
        expect(raw.target).toBe('/file');
    });

    it('isSymlink returns true for a symlink', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        fs.createSymlink('/file', '/link');
        expect(fs.isSymlink('/link')).toBe(true);
        expect(fs.isSymlink('/file')).toBe(false);
    });

    it('readSymlink returns the target path', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        fs.createSymlink('/file', '/link');
        expect(fs.readSymlink('/link')).toBe('/file');
    });

    it('getFileByPath follows a symlink', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        fs.createSymlink('/file', '/link');
        expect(fs.getFileByPath('/link')).toBe('hello');
    });

    it('exists follows a symlink to a valid target', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        fs.createSymlink('/file', '/link');
        expect(fs.exists('/link')).toBe(true);
    });

    it('exists returns false for a broken symlink', () => {
        const fs = new FileSystem('/', {});
        fs.createSymlink('/missing', '/link');
        expect(fs.exists('/link')).toBe(false);
    });

    it('stat returns isSymlink:true without following', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        fs.createSymlink('/file', '/link');
        const s = fs.stat('/link');
        expect(s.isSymlink).toBe(true);
        expect(s.isFile).toBe(false);
    });

    it('stat follows symlinks for a regular file', () => {
        const fs = new FileSystem('/', { file: 'hello' });
        const s = fs.stat('/file');
        expect(s.isFile).toBe(true);
        expect(s.isSymlink).toBe(false);
    });

    it('follows a chain of symlinks', () => {
        const fs = new FileSystem('/', { file: 'hi' });
        fs.createSymlink('/file', '/a');
        fs.createSymlink('/a', '/b');
        expect(fs.getFileByPath('/b')).toBe('hi');
    });

    it('returns null for a symlink loop', () => {
        const fs = new FileSystem('/', {});
        fs.createSymlink('/b', '/a');
        fs.createSymlink('/a', '/b');
        expect(fs.getFileByPath('/a')).toBeNull();
    });

    it('symlink in a subdirectory resolves relative target', () => {
        const fs = new FileSystem('/', { dir: { file: 'content' } });
        fs.createSymlink('file', '/dir/link');     // relative target
        expect(fs.getFileByPath('/dir/link')).toBe('content');
    });

    it('cat reads through a symlink via the shell', async () => {
        const shell = await createShell({ filesystem: { real: 'symlinked content' } });
        await run(shell, 'ln -s /real /lnk');
        const { output } = await run(shell, 'cat /lnk');
        expect(output.join('')).toBe('symlinked content');
    });
});

describe('BRFS Indexed Binary Container & Client-Side Persistence', () => {
    const {
        isBinaryContainer,
        serializeBinaryFilesystem,
        deserializeBinaryFilesystem,
        FilesystemStorage
    } = require('../lib/BinaryContainer.js');

    it('serializes text files, binary files, directories, symlinks, and permissions without base64 bloat', () => {
        const rawPngBytes = new Uint8Array(Buffer.from(RED_PNG_B64, 'base64'));
        const fs = new FileSystem('/', {
            readme: 'Hello BRFS!',
            img: RED_PNG_DATA_URI,
            bin: {
                'script.sh': '#!/sh.js\necho "from container"'
            }
        }, {
            '/readme': 0o644,
            '/bin/script.sh': 0o755
        });
        fs.createSymlink('/readme', '/readme-link');

        const containerBytes = fs.toBinaryContainer();
        expect(containerBytes instanceof Uint8Array).toBe(true);
        expect(isBinaryContainer(containerBytes)).toBe(true);
        // Header magic "BRFS"
        expect(String.fromCharCode(...containerBytes.subarray(0, 4))).toBe('BRFS');

        // Deserialize back into a fresh FileSystem
        const restored = new FileSystem('/', containerBytes);
        expect(restored.getFileByPath('/readme')).toBe('Hello BRFS!');
        expect(restored.getMode('/bin/script.sh')).toBe(0o755);
        expect(restored.isSymlink('/readme-link')).toBe(true);
        expect(restored.getFileByPath('/readme-link')).toBe('Hello BRFS!');

        const restoredImg = restored.getFileByPath('/img');
        expect(restoredImg instanceof BinaryFile).toBe(true);
        expect(restoredImg.length).toBe(rawPngBytes.length);
        expect(restoredImg.toString()).toBe(RED_PNG_DATA_URI);
    });

    it('boots a Shell directly from a serialized BRFS Uint8Array container and preserves executable permissions', async () => {
        const shell1 = await createShell({
            filesystem: {
                home: {
                    'hello.sh': '#!/sh.js\necho "persisted script works"',
                    'notes.txt': 'initial note'
                }
            },
            permissions: {
                '/home/hello.sh': 0o755
            }
        });

        await run(shell1, 'echo "updated note" > /home/notes.txt');
        await run(shell1, 'ln -s /home/notes.txt /home/link.txt');

        // Save snapshot using FilesystemStorage.save()
        const snapshotBytes = await FilesystemStorage.save(shell1);
        expect(isBinaryContainer(snapshotBytes)).toBe(true);

        // Restore into a brand-new Shell instance by passing snapshotBytes as `filesystem`
        const shell2 = await createShell({
            filesystem: snapshotBytes
        });

        const noteRes = await run(shell2, 'cat /home/link.txt');
        expect(noteRes.output.join('')).toBe('updated note');

        const scriptRes = await run(shell2, '/home/hello.sh');
        expect(scriptRes.exitCode).toBe(0);
        expect(scriptRes.output).toContain('persisted script works');
    });

    it('supports createAutoSave onFsChange hook emitting binary snapshots', async () => {
        const snapshots = [];
        const onFsChange = FilesystemStorage.createAutoSave('test-key', (bytes) => {
            snapshots.push(bytes);
        });

        const shell = await createShell({
            filesystem: { home: {} },
            onFsChange
        });

        await run(shell, 'echo "hello auto-save" > /home/auto.txt');
        // Wait a microtask tick for debounced _triggerChange
        await new Promise(r => setTimeout(r, 10));

        expect(snapshots.length).toBeGreaterThan(0);
        const latest = snapshots[snapshots.length - 1];
        expect(isBinaryContainer(latest)).toBe(true);

        const decoded = deserializeBinaryFilesystem(latest);
        expect(decoded.filesystem.home['auto.txt']).toBe('hello auto-save');
    });

    it('accepts a URL string directly in new Shell({ filesystem: "/fs.brfs" }) without a JS loader', async () => {
        const containerBytes = serializeBinaryFilesystem(
            {
                home: {
                    '.profile': '#!/sh.js\nexport FROM_PROFILE="loaded"',
                    'greeting.txt': 'hello from url brfs'
                }
            },
            {
                '/home/greeting.txt': 0o640
            }
        );

        const origFetch = global.fetch;
        global.fetch = async (url) => {
            if (url === 'https://example.test/fs.brfs' || url === '/fs.brfs') {
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => containerBytes.buffer.slice(
                        containerBytes.byteOffset,
                        containerBytes.byteOffset + containerBytes.byteLength
                    )
                };
            }
            throw new Error(`Unexpected URL: ${url}`);
        };

        try {
            class ExtraCmd extends Shell.Command {
                static get name() { return 'extracmd'; }
                get name() { return 'extracmd'; }
                run() {
                    this.stdOut = 'extra command works';
                }
            }

            const shell = new Shell({
                filesystem: '/fs.brfs',
                cwd: '/home',
                profile: '/home/.profile'
            });
            // Register a command synchronously while /fs.brfs is still being fetched
            shell.context.setCommand(ExtraCmd);

            // Commands called immediately automatically wait for /fs.brfs to finish mounting
            const catRes = await run(shell, 'cat greeting.txt');
            expect(catRes.exitCode).toBe(0);
            expect(catRes.output.join('')).toBe('hello from url brfs');

            const envRes = await run(shell, 'echo $FROM_PROFILE');
            expect(envRes.output.join('')).toBe('loaded');

            const cmdRes = await run(shell, 'extracmd');
            expect(cmdRes.exitCode).toBe(0);
            expect(cmdRes.output.join('')).toBe('extra command works');

            expect(shell.context.fs.getMode('/home/greeting.txt')).toBe(0o640);
        } finally {
            global.fetch = origFetch;
        }
    });

    it('accepts a Promise (such as Shell.Storage.loadOrFetch) or gzipped .brfs bytes directly', async () => {
        const zlib = require('zlib');
        const containerBytes = serializeBinaryFilesystem(
            { data: { 'msg.txt': 'compressed brfs works' } },
            { '/data/msg.txt': 0o600 }
        );
        const gzippedBytes = new Uint8Array(zlib.gzipSync(Buffer.from(containerBytes)));

        const shell = new Shell({
            filesystem: FilesystemStorage.loadOrFetch('non-existent-key', Promise.resolve(gzippedBytes)),
            cwd: '/data'
        });

        const res = await run(shell, 'cat msg.txt');
        expect(res.exitCode).toBe(0);
        expect(res.output.join('')).toBe('compressed brfs works');
        expect(shell.context.fs.getMode('/data/msg.txt')).toBe(0o600);
    });
});


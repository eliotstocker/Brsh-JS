import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
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

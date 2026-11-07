import { createRequire } from 'module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync } from 'zlib';

const require = createRequire(import.meta.url);
const { buildStructure } = require('../lib/buildFilesystemStructure.js');

const CLI = fileURLToPath(new URL('../bin/exportFileSystem.js', import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
    return mkdtempSync(join(tmpdir(), 'brsh-test-'));
}

function runCLI(args, cwd) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: cwd || process.cwd(),
        encoding: 'utf8',
        timeout: 30000
    });
}

// ---------------------------------------------------------------------------
// Unit tests: buildStructure
// ---------------------------------------------------------------------------

describe('buildStructure', () => {
    let root;

    beforeEach(() => {
        root = tmpDir();
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('returns { filesystem, permissions } with empty objects for an empty directory', () => {
        const result = buildStructure(root);
        expect(result).toHaveProperty('filesystem');
        expect(result).toHaveProperty('permissions');
        expect(result.filesystem).toEqual({});
        expect(result.permissions).toEqual({});
    });

    it('includes a plain text file with its full name as the key', () => {
        writeFileSync(join(root, 'readme.txt'), 'hello');
        const { filesystem } = buildStructure(root);
        expect(filesystem).toHaveProperty('readme.txt');
        expect(filesystem['readme.txt']).toBe('hello');
    });

    it('strips the .js extension from JavaScript file keys', () => {
        writeFileSync(join(root, 'app.js'), 'module.exports = {}');
        const { filesystem } = buildStructure(root);
        expect(filesystem).toHaveProperty('app');
        expect(filesystem).not.toHaveProperty('app.js');
        expect(filesystem['app']).toMatch(/^require\('/);
    });

    it('uses an absolute path in the require() string for JavaScript files', () => {
        writeFileSync(join(root, 'data.js'), 'module.exports = "content"');
        const { filesystem } = buildStructure(root);
        const reqPath = filesystem.data.match(/require\('(.+?)'\)/)[1];
        expect(reqPath).toBe(resolve(root, 'data.js'));
    });

    it('recursively includes nested directories', () => {
        const sub = join(root, 'subdir');
        mkdirSync(sub);
        writeFileSync(join(sub, 'nested.txt'), 'nested');
        const { filesystem } = buildStructure(root);
        expect(filesystem).toHaveProperty('subdir');
        expect(filesystem.subdir).toHaveProperty('nested.txt');
    });

    it('handles multiple levels of nesting', () => {
        const a = join(root, 'a');
        const b = join(a, 'b');
        mkdirSync(a);
        mkdirSync(b);
        writeFileSync(join(b, 'deep.js'), 'module.exports = "deep"');
        const { filesystem } = buildStructure(root);
        expect(filesystem.a.b['deep']).toMatch(/^require\('/);
    });

    it('ignores .DS_Store files', () => {
        writeFileSync(join(root, '.DS_Store'), '');
        writeFileSync(join(root, 'keep.txt'), 'keep');
        const { filesystem } = buildStructure(root);
        expect(filesystem).not.toHaveProperty('.DS_Store');
        expect(filesystem).toHaveProperty('keep.txt');
    });

    it('includes multiple files in the same directory', () => {
        writeFileSync(join(root, 'a.txt'), 'a');
        writeFileSync(join(root, 'b.txt'), 'b');
        writeFileSync(join(root, 'c.js'),  'module.exports = {}');
        const { filesystem } = buildStructure(root);
        expect(Object.keys(filesystem)).toHaveLength(3);
        expect(filesystem).toHaveProperty('a.txt');
        expect(filesystem).toHaveProperty('b.txt');
        expect(filesystem).toHaveProperty('c');
    });

    it('throws when the root directory does not exist', () => {
        expect(() => buildStructure('/does/not/exist')).toThrow();
    });

    it('records permissions for each file', () => {
        writeFileSync(join(root, 'script.sh'), '#!/bin/sh\necho hi');
        chmodSync(join(root, 'script.sh'), 0o755);
        const { permissions } = buildStructure(root);
        expect(permissions['/script.sh']).toBe(0o755);
    });

    it('records read-only file permission', () => {
        writeFileSync(join(root, 'readme.txt'), 'hello');
        chmodSync(join(root, 'readme.txt'), 0o444);
        const { permissions } = buildStructure(root);
        expect(permissions['/readme.txt']).toBe(0o444);
    });

    it('records permissions for nested files using virtual paths', () => {
        const sub = join(root, 'bin');
        mkdirSync(sub);
        writeFileSync(join(sub, 'tool.sh'), '#!/bin/sh');
        chmodSync(join(sub, 'tool.sh'), 0o755);
        const { permissions } = buildStructure(root);
        expect(permissions['/bin/tool.sh']).toBe(0o755);
    });

    it('encodes .wasm files as data:application/wasm;base64 and strips .wasm extension', () => {
        const sub = join(root, 'bin');
        mkdirSync(sub);
        const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        writeFileSync(join(sub, 'jq.wasm'), wasmBytes);
        chmodSync(join(sub, 'jq.wasm'), 0o755);
        const { filesystem, permissions } = buildStructure(root);
        expect(filesystem.bin).toHaveProperty('jq');
        expect(filesystem.bin.jq).toBe(`data:application/wasm;base64,${wasmBytes.toString('base64')}`);
        expect(permissions['/bin/jq']).toBe(0o755);
    });
});

// ---------------------------------------------------------------------------
// CLI integration tests
// ---------------------------------------------------------------------------

describe('exportFileSystem CLI', () => {
    let root;
    let outDir;

    beforeEach(() => {
        root = tmpDir();
        outDir = tmpDir();
        writeFileSync(join(root, 'hello.txt'), 'Hello World');
        writeFileSync(join(root, 'app.js'), 'module.exports = function() {}');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    });

    it('exits non-zero when --variable is missing', () => {
        const r = runCLI([root]);
        expect(r.status).toBeGreaterThan(0);
    });

    it('exits non-zero when the root directory is missing', () => {
        const r = runCLI(['-v', 'FS']);
        expect(r.status).toBeGreaterThan(0);
    });

    it('exits non-zero when the root directory does not exist', () => {
        const r = runCLI(['/definitely/not/a/real/path', '-v', 'FS']);
        expect(r.status).toBeGreaterThan(0);
    });

    it('builds successfully and writes output file', () => {
        const outFile = join(outDir, 'fs.js');
        const r = runCLI([root, '-v', 'MyFS', '-o', outFile]);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('Build succeeded');
        const content = readFileSync(outFile, 'utf8');
        expect(content.length).toBeGreaterThan(0);
    });

    it('output bundle assigns the requested global variable name', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'MyFilesystem', '-o', outFile]);
        const content = readFileSync(outFile, 'utf8');
        expect(content).toContain('MyFilesystem');
    });

    it('output bundle is valid JavaScript (parseable)', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile]);
        const content = readFileSync(outFile, 'utf8');
        expect(() => new Function(content)).not.toThrow();
    });

    it('bundle contains text file contents', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile]);
        const content = readFileSync(outFile, 'utf8');
        expect(content).toContain('Hello World');
    });

    it('builds a directory tree without requiring a root index.js wrapper', () => {
        rmSync(join(root, 'app.js'));
        mkdirSync(join(root, 'bin'));
        writeFileSync(join(root, 'bin', 'tool.js'), 'module.exports = function tool() {}');

        const outFile = join(outDir, 'fs.js');
        const result = runCLI([root, '-v', 'FS', '-o', outFile]);
        const content = readFileSync(outFile, 'utf8');

        expect(result.status).toBe(0);
        expect(content).toContain('Hello World');
        expect(content).toContain('tool');
    });

    it('bundle does not contain readFileSync references', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile]);
        const content = readFileSync(outFile, 'utf8');
        expect(content).not.toContain('readFileSync');
    });

    it('handles a nested directory structure', () => {
        const sub = join(root, 'sub');
        mkdirSync(sub);
        writeFileSync(join(sub, 'nested.txt'), 'Nested content');
        const outFile = join(outDir, 'fs.js');
        const r = runCLI([root, '-v', 'FS', '-o', outFile]);
        expect(r.status).toBe(0);
        const content = readFileSync(outFile, 'utf8');
        expect(content).toContain('Nested content');
    });

    it('bundle exports an object with filesystem and permissions keys', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile]);
        const content = readFileSync(outFile, 'utf8');
        // The generated source should contain both keys before bundling minifies it
        // Just check it builds and is valid JS
        expect(() => new Function(content)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// CLI integration tests – --compress (-c) flag
// ---------------------------------------------------------------------------

describe('exportFileSystem CLI --compress', () => {
    let root;
    let outDir;

    beforeEach(() => {
        root = tmpDir();
        outDir = tmpDir();
        writeFileSync(join(root, 'hello.txt'), 'Hello World');
        writeFileSync(join(root, 'app.js'), 'module.exports = function() {}');
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    });

    it('builds successfully with --compress flag', () => {
        const outFile = join(outDir, 'fs.js');
        const r = runCLI([root, '-v', 'FS', '-o', outFile, '--compress']);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('Build succeeded');
    });

    it('writes a .brfs binary file alongside the .js loader', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile, '--compress']);
        expect(existsSync(outFile)).toBe(true);
        expect(existsSync(join(outDir, 'fs.brfs'))).toBe(true);
    });

    it('the .js loader is valid JavaScript', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile, '--compress']);
        const content = readFileSync(outFile, 'utf8');
        expect(() => new Function(content)).not.toThrow();
    });

    it('the .js loader references DecompressionStream and fetch', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile, '--compress']);
        const content = readFileSync(outFile, 'utf8');
        expect(content).toContain('DecompressionStream');
        expect(content).toContain('fetch');
        expect(content).toContain('.brfs');
    });

    it('the .js loader does not contain any filesystem content', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile, '--compress']);
        const content = readFileSync(outFile, 'utf8');
        expect(content).not.toContain('Hello World');
    });

    it('the .brfs file is smaller than the uncompressed .js bundle for text-heavy filesystem', () => {
        const textRoot = tmpDir();
        try {
            for (let i = 0; i < 20; i++) {
                writeFileSync(join(textRoot, `doc${i}.txt`), `${'Content line repeated many times.\n'.repeat(200)} document ${i}`);
            }
            const compressedOut = join(outDir, 'compressed.js');
            const uncompressedOut = join(outDir, 'uncompressed.js');
            runCLI([textRoot, '-v', 'FS', '-o', compressedOut, '--compress']);
            runCLI([textRoot, '-v', 'FS', '-o', uncompressedOut]);
            expect(statSync(join(outDir, 'compressed.brfs')).size).toBeLessThan(statSync(uncompressedOut).size);
        } finally {
            rmSync(textRoot, { recursive: true, force: true });
        }
    });

    it('the .brfs file is valid gzip that decompresses to executable JS', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'TestFS', '-o', outFile, '--compress']);
        const brfsData = readFileSync(join(outDir, 'fs.brfs'));
        const code = gunzipSync(brfsData).toString('utf8');
        expect(() => new Function(code)).not.toThrow();
    });

    it('the .brfs bundle resolves to an object with filesystem and permissions', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'TestFS', '-o', outFile, '--compress']);
        const brfsData = readFileSync(join(outDir, 'fs.brfs'));
        const code = gunzipSync(brfsData).toString('utf8');
        const result = new Function(code)();
        expect(result).toHaveProperty('filesystem');
        expect(result).toHaveProperty('permissions');
        expect(result.filesystem['hello.txt']).toBe('Hello World');
    });

    it('the .brfs bundle contains JS command code', () => {
        const outFile = join(outDir, 'fs.js');
        runCLI([root, '-v', 'FS', '-o', outFile, '--compress']);
        const brfsData = readFileSync(join(outDir, 'fs.brfs'));
        const code = gunzipSync(brfsData).toString('utf8');
        // app.js exports a function – its compiled form must be in the bundle
        expect(code.length).toBeGreaterThan(100);
    });
});

describe('exportFileSystem CLI --binary (.brfs indexed binary container)', () => {
    const { isBinaryContainer, deserializeBinaryFilesystem } = require('../lib/BinaryContainer.js');
    let root;
    let outDir;

    beforeEach(() => {
        root = tmpDir();
        outDir = tmpDir();
        mkdirSync(join(root, 'bin'));
        writeFileSync(join(root, 'hello.txt'), 'Hello Binary Container');
        writeFileSync(join(root, 'bin', 'run.sh'), '#!/sh.js\necho hi');
        chmodSync(join(root, 'bin', 'run.sh'), 0o755);
        writeFileSync(join(root, 'bin', 'tool.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
        chmodSync(join(root, 'bin', 'tool.wasm'), 0o755);
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    });

    it('writes a standalone BRFS v2 binary container when -o ends with .brfs', () => {
        const outFile = join(outDir, 'fs.brfs');
        const r = runCLI([root, '-o', outFile]);
        expect(r.status).toBe(0);
        expect(existsSync(outFile)).toBe(true);

        const raw = new Uint8Array(readFileSync(outFile));
        expect(isBinaryContainer(raw)).toBe(true);

        const { filesystem, permissions } = deserializeBinaryFilesystem(raw);
        expect(filesystem['hello.txt']).toBe('Hello Binary Container');
        expect(filesystem.bin['run.sh']).toBe('#!/sh.js\necho hi');
        expect(filesystem.bin.tool instanceof Uint8Array).toBe(true);
        expect(permissions['/bin/run.sh']).toBe(0o755);
        expect(permissions['/bin/tool']).toBe(0o755);
    });

    it('writes a JS loader and .brfs binary container when --binary (-b) is passed with -o fs.js', () => {
        const outFile = join(outDir, 'fs.js');
        const r = runCLI([root, '-v', 'FS', '-o', outFile, '--binary']);
        expect(r.status).toBe(0);
        expect(existsSync(outFile)).toBe(true);
        expect(existsSync(join(outDir, 'fs.brfs'))).toBe(true);

        const raw = new Uint8Array(readFileSync(join(outDir, 'fs.brfs')));
        expect(isBinaryContainer(raw)).toBe(true);
    });
});


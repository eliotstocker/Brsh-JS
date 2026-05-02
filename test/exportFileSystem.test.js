import { createRequire } from 'module';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

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

    it('returns an empty object for an empty directory', () => {
        expect(buildStructure(root)).toEqual({});
    });

    it('includes a plain text file with its full name as the key', () => {
        writeFileSync(join(root, 'readme.txt'), 'hello');
        const struct = buildStructure(root);
        expect(struct).toHaveProperty('readme.txt');
        expect(struct['readme.txt']).toMatch(/^require\('/);
        expect(struct['readme.txt']).toContain('readme.txt');
    });

    it('strips the .js extension from JavaScript file keys', () => {
        writeFileSync(join(root, 'app.js'), 'module.exports = {}');
        const struct = buildStructure(root);
        expect(struct).toHaveProperty('app');
        expect(struct).not.toHaveProperty('app.js');
        expect(struct['app']).toMatch(/^require\('/);
    });

    it('uses an absolute path in the require() string', () => {
        writeFileSync(join(root, 'data.txt'), 'content');
        const struct = buildStructure(root);
        const reqPath = struct['data.txt'].match(/require\('(.+?)'\)/)[1];
        expect(reqPath).toBe(resolve(root, 'data.txt'));
    });

    it('recursively includes nested directories', () => {
        const sub = join(root, 'subdir');
        mkdirSync(sub);
        writeFileSync(join(sub, 'nested.txt'), 'nested');
        const struct = buildStructure(root);
        expect(struct).toHaveProperty('subdir');
        expect(struct.subdir).toHaveProperty('nested.txt');
    });

    it('handles multiple levels of nesting', () => {
        const a = join(root, 'a');
        const b = join(a, 'b');
        mkdirSync(a);
        mkdirSync(b);
        writeFileSync(join(b, 'deep.txt'), 'deep');
        const struct = buildStructure(root);
        expect(struct.a.b['deep.txt']).toMatch(/^require\('/);
    });

    it('ignores .DS_Store files', () => {
        writeFileSync(join(root, '.DS_Store'), '');
        writeFileSync(join(root, 'keep.txt'), 'keep');
        const struct = buildStructure(root);
        expect(struct).not.toHaveProperty('.DS_Store');
        expect(struct).toHaveProperty('keep.txt');
    });

    it('includes multiple files in the same directory', () => {
        writeFileSync(join(root, 'a.txt'), 'a');
        writeFileSync(join(root, 'b.txt'), 'b');
        writeFileSync(join(root, 'c.js'),  'module.exports = {}');
        const struct = buildStructure(root);
        expect(Object.keys(struct)).toHaveLength(3);
        expect(struct).toHaveProperty('a.txt');
        expect(struct).toHaveProperty('b.txt');
        expect(struct).toHaveProperty('c');
    });

    it('throws when the root directory does not exist', () => {
        expect(() => buildStructure('/does/not/exist')).toThrow();
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
});

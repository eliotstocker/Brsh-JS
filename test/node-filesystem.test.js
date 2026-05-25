import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createShell, run } from './helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('useRealFilesystem', () => {
    let tmpDir;
    let shell;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brsh-test-'));
        fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello World\nFoo Bar');
        fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'other content');
        fs.mkdirSync(path.join(tmpDir, 'subdir'));
        fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content');

        shell = await createShell({ useRealFilesystem: true, cwd: tmpDir });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('ls lists real files in cwd', async () => {
        const { output } = await run(shell, 'ls');
        expect(output.join(' ')).toMatch(/hello\.txt/);
        expect(output.join(' ')).toMatch(/other\.txt/);
        expect(output.join(' ')).toMatch(/subdir/);
    });

    it('ls lists files at an explicit real path', async () => {
        const { output } = await run(shell, `ls ${tmpDir}/subdir`);
        expect(output.join(' ')).toMatch(/nested\.txt/);
    });

    it('cat reads real file content', async () => {
        const { output } = await run(shell, `cat ${tmpDir}/hello.txt`);
        expect(output).toContain('Hello World');
        expect(output).toContain('Foo Bar');
    });

    it('grep searches a real file', async () => {
        const { output, exitCode } = await run(shell, `grep Foo ${tmpDir}/hello.txt`);
        expect(output).toContain('Foo Bar');
        expect(exitCode).toBe(0);
    });

    it('grep -r searches recursively through real dirs', async () => {
        const { output } = await run(shell, `grep -r nested ${tmpDir}`);
        expect(output.some(l => l.includes('nested content'))).toBe(true);
    });

    it('mkdir creates a real directory', async () => {
        await run(shell, `mkdir ${tmpDir}/newdir`);
        expect(fs.existsSync(path.join(tmpDir, 'newdir'))).toBe(true);
        expect(fs.statSync(path.join(tmpDir, 'newdir')).isDirectory()).toBe(true);
    });

    it('mkdir -p creates nested real directories', async () => {
        await run(shell, `mkdir -p ${tmpDir}/a/b/c`);
        expect(fs.existsSync(path.join(tmpDir, 'a', 'b', 'c'))).toBe(true);
    });

    it('rm deletes a real file', async () => {
        await run(shell, `rm ${tmpDir}/other.txt`);
        expect(fs.existsSync(path.join(tmpDir, 'other.txt'))).toBe(false);
    });

    it('rm -r deletes a real directory tree', async () => {
        await run(shell, `rm -r ${tmpDir}/subdir`);
        expect(fs.existsSync(path.join(tmpDir, 'subdir'))).toBe(false);
    });

    it('cp copies a real file', async () => {
        await run(shell, `cp ${tmpDir}/hello.txt ${tmpDir}/hello-copy.txt`);
        expect(fs.existsSync(path.join(tmpDir, 'hello-copy.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(tmpDir, 'hello-copy.txt'), 'utf8')).toBe('Hello World\nFoo Bar');
    });

    it('cp -r copies a real directory tree', async () => {
        await run(shell, `cp -r ${tmpDir}/subdir ${tmpDir}/subdir-copy`);
        expect(fs.existsSync(path.join(tmpDir, 'subdir-copy', 'nested.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(tmpDir, 'subdir-copy', 'nested.txt'), 'utf8')).toBe('nested content');
    });

    it('mv renames a real file', async () => {
        await run(shell, `mv ${tmpDir}/other.txt ${tmpDir}/renamed.txt`);
        expect(fs.existsSync(path.join(tmpDir, 'other.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(tmpDir, 'renamed.txt'), 'utf8')).toBe('other content');
    });

    it('ls -l shows real file permissions', async () => {
        const { output } = await run(shell, `ls -l ${tmpDir}`);
        expect(output.some(l => l.includes('hello.txt') && l.match(/^-[rwx-]{9}/))).toBe(true);
    });

    it('ls -l uses real file size', async () => {
        const realSize = fs.statSync(path.join(tmpDir, 'hello.txt')).size;
        const { output } = await run(shell, `ls -l ${tmpDir}`);
        const line = output.find(l => l.includes('hello.txt'));
        expect(line).toContain(String(realSize));
    });

    it('chmod changes real file permissions', async () => {
        await run(shell, `chmod 755 ${tmpDir}/hello.txt`);
        expect(fs.statSync(path.join(tmpDir, 'hello.txt')).mode & 0o777).toBe(0o755);
    });

    it('pwd shows the real cwd', async () => {
        const { output } = await run(shell, 'pwd');
        expect(output[0]).toBe(tmpDir);
    });

    it('cd changes the real cwd', async () => {
        await shell.onCommand(`cd ${tmpDir}/subdir`);
        const { output } = await run(shell, 'pwd');
        expect(output[0]).toBe(path.join(tmpDir, 'subdir'));
    });

    it('echo and other builtins still work', async () => {
        const { output } = await run(shell, 'echo hello world');
        expect(output).toContain('hello world');
    });

    it('scripts run against the real filesystem', async () => {
        const scriptPath = path.join(tmpDir, 'check.sh');
        fs.writeFileSync(scriptPath, `#!/sh.js\ncat ${tmpDir}/hello.txt`);
        fs.chmodSync(scriptPath, 0o755);
        const { output } = await run(shell, scriptPath);
        expect(output).toContain('Hello World');
    });

    it('executable .js files are loaded as command classes', async () => {
        const commandPath = path.resolve(__dirname, '../lib/Command.js');
        const jsContent = `'use strict';
const Command = require(${JSON.stringify(commandPath)});
class Hello extends Command {
    static get name() { return 'hello'; }
    run() { return Promise.resolve('hello from js bin'); }
}
module.exports = Hello;
`;
        const binPath = path.join(tmpDir, 'hello.js');
        fs.writeFileSync(binPath, jsContent);
        fs.chmodSync(binPath, 0o755);
        const { output, exitCode } = await run(shell, binPath);
        expect(exitCode).toBe(0);
        expect(output).toContain('hello from js bin');
    });
});

// ---------------------------------------------------------------------------
// touch
// ---------------------------------------------------------------------------
describe('touch', () => {
    let tmpDir;
    let shell;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brsh-touch-'));
        shell = await createShell({ useRealFilesystem: true, cwd: tmpDir });
    });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('creates a new empty file', async () => {
        const { exitCode } = await run(shell, 'touch newfile.txt');
        expect(exitCode).toBe(0);
        expect(fs.existsSync(path.join(tmpDir, 'newfile.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(tmpDir, 'newfile.txt'), 'utf8')).toBe('');
    });

    it('does not overwrite existing file content', async () => {
        fs.writeFileSync(path.join(tmpDir, 'existing.txt'), 'keep me');
        await run(shell, 'touch existing.txt');
        expect(fs.readFileSync(path.join(tmpDir, 'existing.txt'), 'utf8')).toBe('keep me');
    });

    it('updates mtime of existing file', async () => {
        const filePath = path.join(tmpDir, 'old.txt');
        fs.writeFileSync(filePath, 'data');
        const epoch = new Date('2000-01-01T00:00:00Z');
        fs.utimesSync(filePath, epoch, epoch);
        const before = fs.statSync(filePath).mtime;

        await run(shell, 'touch old.txt');

        const after = fs.statSync(filePath).mtime;
        expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('-c does not create a missing file', async () => {
        const { exitCode } = await run(shell, 'touch -c ghost.txt');
        expect(exitCode).toBe(0);
        expect(fs.existsSync(path.join(tmpDir, 'ghost.txt'))).toBe(false);
    });

    it('creates multiple files', async () => {
        await run(shell, 'touch a.txt b.txt c.txt');
        expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'b.txt'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'c.txt'))).toBe(true);
    });

    it('works on virtual filesystem', async () => {
        const vshell = await createShell({ filesystem: { home: {} } });
        const { exitCode } = await run(vshell, 'touch /home/newfile.txt');
        expect(exitCode).toBe(0);
        expect(vshell.context.fs.exists('/home/newfile.txt')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// ln
// ---------------------------------------------------------------------------
describe('ln', () => {
    let tmpDir;
    let shell;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brsh-ln-'));
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
        shell = await createShell({ useRealFilesystem: true, cwd: tmpDir });
    });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('creates a symlink with ln -s', async () => {
        const { exitCode } = await run(shell, 'ln -s file.txt link.txt');
        expect(exitCode).toBe(0);
        expect(fs.lstatSync(path.join(tmpDir, 'link.txt')).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(path.join(tmpDir, 'link.txt'))).toBe('file.txt');
    });

    it('symlink target is readable', async () => {
        await run(shell, 'ln -s file.txt link.txt');
        const { output } = await run(shell, 'cat link.txt');
        expect(output.join('')).toBe('hello');
    });

    it('creates a hard link', async () => {
        const { exitCode } = await run(shell, 'ln file.txt hardlink.txt');
        expect(exitCode).toBe(0);
        const orig = fs.statSync(path.join(tmpDir, 'file.txt'));
        const link = fs.statSync(path.join(tmpDir, 'hardlink.txt'));
        expect(link.ino).toBe(orig.ino);
    });

    it('-f overwrites existing symlink', async () => {
        fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'other');
        await run(shell, 'ln -s file.txt link.txt');
        const { exitCode } = await run(shell, 'ln -sf other.txt link.txt');
        expect(exitCode).toBe(0);
        expect(fs.readlinkSync(path.join(tmpDir, 'link.txt'))).toBe('other.txt');
    });

    it('errors when source missing for hard link', async () => {
        const { exitCode, errors } = await run(shell, 'ln ghost.txt link.txt');
        expect(exitCode).toBe(1);
        expect(errors.join('')).toMatch(/ghost\.txt/);
    });

    it('errors with missing operands', async () => {
        const { exitCode, errors } = await run(shell, 'ln');
        expect(exitCode).toBe(1);
        expect(errors.join('')).toMatch(/missing/);
    });
});

// ---------------------------------------------------------------------------
// stat
// ---------------------------------------------------------------------------
describe('stat', () => {
    let tmpDir;
    let shell;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brsh-stat-'));
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello world');
        fs.mkdirSync(path.join(tmpDir, 'subdir'));
        shell = await createShell({ useRealFilesystem: true, cwd: tmpDir });
    });
    afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('outputs file info for a regular file', async () => {
        const { output, exitCode } = await run(shell, 'stat file.txt');
        expect(exitCode).toBe(0);
        const out = output.join('\n');
        expect(out).toMatch(/file\.txt/);
        expect(out).toMatch(/regular file/);
        expect(out).toMatch(/\d+/); // size
    });

    it('outputs directory info', async () => {
        const { output, exitCode } = await run(shell, 'stat subdir');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toMatch(/directory/);
    });

    it('reports symlink type without following', async () => {
        fs.symlinkSync('file.txt', path.join(tmpDir, 'link.txt'));
        const { output, exitCode } = await run(shell, 'stat link.txt');
        expect(exitCode).toBe(0);
        const out = output.join('\n');
        expect(out).toMatch(/symbolic link/);
        expect(out).toMatch(/-> file\.txt/);
    });

    it('errors for missing file', async () => {
        const { exitCode, errors } = await run(shell, 'stat ghost.txt');
        expect(exitCode).toBe(1);
        expect(errors.join('')).toMatch(/No such file/);
    });

    it('works on virtual filesystem', async () => {
        const vshell = await createShell({ filesystem: { 'readme.txt': 'hello' } });
        const { output, exitCode } = await run(vshell, 'stat /readme.txt');
        expect(exitCode).toBe(0);
        expect(output.join('\n')).toMatch(/readme\.txt/);
    });
});

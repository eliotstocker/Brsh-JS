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
});

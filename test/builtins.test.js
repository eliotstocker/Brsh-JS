import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

describe('echo', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('outputs its argument', async () => {
        const { output } = await run(shell, 'echo hello');
        expect(output).toContain('hello');
    });

    it('outputs a multi-word quoted string', async () => {
        const { output } = await run(shell, 'echo "hello world"');
        expect(output).toContain('hello world');
    });

    it('outputs multiple unquoted arguments joined with spaces', async () => {
        const { output } = await run(shell, 'echo hello world');
        expect(output).toContain('hello world');
    });

    it('outputs an expanded variable', async () => {
        await shell.onCommand('export FOO=bar');
        const { output } = await run(shell, 'echo $FOO');
        expect(output).toContain('bar');
    });
});

describe('ls', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'file.txt': 'hello',
                    '.hidden': 'secret',
                    subdir: {}
                }
            },
            cwd: '/'
        });
    });

    it('lists files in the current directory', async () => {
        await shell.onCommand('cd /home');
        const { output } = await run(shell, 'ls');
        expect(output.join(' ')).toMatch(/file\.txt/);
    });

    it('lists files at an explicit path', async () => {
        const { output } = await run(shell, 'ls /home');
        expect(output.join(' ')).toMatch(/file\.txt/);
    });

    it('hides dotfiles without -a', async () => {
        await shell.onCommand('cd /home');
        const { output } = await run(shell, 'ls');
        expect(output.join(' ')).not.toMatch(/\.hidden/);
    });

    it('shows dotfiles with -a', async () => {
        await shell.onCommand('cd /home');
        const { output } = await run(shell, 'ls -a');
        expect(output.join(' ')).toMatch(/\.hidden/);
    });

    it('shows long listing with -l', async () => {
        await shell.onCommand('cd /home');
        const { output } = await run(shell, 'ls -l');
        expect(output.some((l) => l.includes('rw') || l.includes('drw'))).toBe(true);
    });

    it('errors on a non-existent path', async () => {
        const { errors, exitCode } = await run(shell, 'ls /does/not/exist');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('shows help with -h', async () => {
        const { output } = await run(shell, 'ls -h');
        expect(output.join(' ')).toMatch(/usage/i);
    });
});

describe('cat', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: { 'readme.txt': 'Hello from cat' }
            }
        });
    });

    it('outputs file contents', async () => {
        const { output } = await run(shell, 'cat /home/readme.txt');
        expect(output).toContain('Hello from cat');
    });

    it('errors on a missing file', async () => {
        const { errors, exitCode } = await run(shell, 'cat /home/missing.txt');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors when targeting a directory', async () => {
        const { errors, exitCode } = await run(shell, 'cat /home');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors when called with no arguments', async () => {
        const { errors, exitCode } = await run(shell, 'cat');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });
});

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

    it('shows correct permissions for a regular file', async () => {
        const { output } = await run(shell, 'ls -l /home');
        const fileLine = output.find(l => l.includes('file.txt'));
        expect(fileLine).toBeDefined();
        expect(fileLine).toMatch(/^-rw-r--r--/);
    });

    it('shows correct permissions for a directory', async () => {
        const { output } = await run(shell, 'ls -l /home');
        const dirLine = output.find(l => l.includes('subdir'));
        expect(dirLine).toBeDefined();
        expect(dirLine).toMatch(/^drwxr-xr-x/);
    });

    it('shows updated permissions after chmod', async () => {
        await shell.onCommand('chmod 755 /home/file.txt');
        const { output } = await run(shell, 'ls -l /home');
        const fileLine = output.find(l => l.includes('file.txt'));
        expect(fileLine).toMatch(/^-rwxr-xr-x/);
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

describe('true / false', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('true exits with code 0', async () => {
        const { exitCode } = await run(shell, 'true');
        expect(exitCode).toBe(0);
    });

    it('false exits with code 1', async () => {
        const { exitCode } = await run(shell, 'false');
        expect(exitCode).toBe(1);
    });
});

describe('test and [ ]', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: { home: { 'readme.txt': 'hi', subdir: {} } }
        });
    });

    it('exits 0 when strings are equal (=)', async () => {
        const { exitCode } = await run(shell, 'test hello = hello');
        expect(exitCode).toBe(0);
    });

    it('exits 1 when strings differ (=)', async () => {
        const { exitCode } = await run(shell, 'test hello = world');
        expect(exitCode).toBe(1);
    });

    it('exits 0 for != when strings differ', async () => {
        const { exitCode } = await run(shell, 'test a != b');
        expect(exitCode).toBe(0);
    });

    it('exits 0 for -n with non-empty string', async () => {
        const { exitCode } = await run(shell, 'test -n hello');
        expect(exitCode).toBe(0);
    });

    it('exits 1 for -n with empty string', async () => {
        const { exitCode } = await run(shell, 'test -n ""');
        expect(exitCode).toBe(1);
    });

    it('exits 0 for -z with empty string', async () => {
        const { exitCode } = await run(shell, 'test -z ""');
        expect(exitCode).toBe(0);
    });

    it('exits 0 for numeric -eq', async () => {
        const { exitCode } = await run(shell, 'test 5 -eq 5');
        expect(exitCode).toBe(0);
    });

    it('exits 1 for numeric -eq when not equal', async () => {
        const { exitCode } = await run(shell, 'test 5 -eq 6');
        expect(exitCode).toBe(1);
    });

    it('exits 0 for -gt when greater', async () => {
        const { exitCode } = await run(shell, 'test 10 -gt 3');
        expect(exitCode).toBe(0);
    });

    it('exits 1 for -gt when not greater', async () => {
        const { exitCode } = await run(shell, 'test 3 -gt 10');
        expect(exitCode).toBe(1);
    });

    it('exits 0 for -f on an existing file', async () => {
        const { exitCode } = await run(shell, 'test -f /home/readme.txt');
        expect(exitCode).toBe(0);
    });

    it('exits 1 for -f on a directory', async () => {
        const { exitCode } = await run(shell, 'test -f /home/subdir');
        expect(exitCode).toBe(1);
    });

    it('exits 0 for -d on a directory', async () => {
        const { exitCode } = await run(shell, 'test -d /home/subdir');
        expect(exitCode).toBe(0);
    });

    it('exits 1 for -d on a file', async () => {
        const { exitCode } = await run(shell, 'test -d /home/readme.txt');
        expect(exitCode).toBe(1);
    });

    it('bracket syntax [ ] works the same as test', async () => {
        const { exitCode } = await run(shell, '[ hello = hello ]');
        expect(exitCode).toBe(0);
    });

    it('bracket syntax exits 1 for false condition', async () => {
        const { exitCode } = await run(shell, '[ hello = world ]');
        expect(exitCode).toBe(1);
    });

    it('! negates the result', async () => {
        const { exitCode } = await run(shell, 'test ! hello = world');
        expect(exitCode).toBe(0);
    });
});

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

describe('echo flags', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('-n suppresses trailing newline (emits same lines)', async () => {
        const { output } = await run(shell, 'echo -n hello');
        expect(output).toContain('hello');
    });

    it('-e interprets \\n as a newline', async () => {
        const { output } = await run(shell, 'echo -e "line1\\nline2"');
        expect(output).toContain('line1');
        expect(output).toContain('line2');
    });

    it('-e interprets \\t as a tab', async () => {
        const { output } = await run(shell, 'echo -e "a\\tb"');
        expect(output.join('')).toContain('a\tb');
    });

    it('-ne combines -n and -e', async () => {
        const { output } = await run(shell, 'echo -ne "x\\ny"');
        expect(output).toContain('x');
        expect(output).toContain('y');
    });
});

describe('cat flags', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: { home: { 'file.txt': 'line1\nline2\nline3' } }
        });
    });

    it('-n numbers all lines', async () => {
        const { output } = await run(shell, 'cat -n /home/file.txt');
        expect(output.some(l => l.match(/^\s+1\t/))).toBe(true);
        expect(output.some(l => l.match(/^\s+3\t/))).toBe(true);
    });

    it('concatenates multiple files', async () => {
        await run(shell, 'mkdir /home/more');
        await run(shell, 'mkdir -p /tmp');
        // create second file via a different approach — use the filesystem directly
        shell.context.fs.setFileByPath('/home/file2.txt', 'line4');
        const { output } = await run(shell, 'cat /home/file.txt /home/file2.txt');
        expect(output).toContain('line1');
        expect(output).toContain('line4');
    });

    it('-s squeezes consecutive blank lines', async () => {
        shell.context.fs.setFileByPath('/home/blank.txt', 'a\n\n\nb');
        const { output } = await run(shell, 'cat -s /home/blank.txt');
        const blanks = output.filter(l => l === '');
        expect(blanks.length).toBeLessThanOrEqual(1);
    });

    it('errors on missing file', async () => {
        const { errors, exitCode } = await run(shell, 'cat /nope.txt');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.length).toBeGreaterThan(0);
    });
});

describe('ls new flags', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'file.txt': 'hello',
                    subdir: { 'inner.txt': 'inner' }
                }
            },
            cwd: '/home'
        });
    });

    it('-1 prints one entry per line', async () => {
        const { output } = await run(shell, 'ls -1 /home');
        expect(output.length).toBeGreaterThanOrEqual(2);
        expect(output).toContain('file.txt');
        expect(output).toContain('subdir');
    });

    it('-F appends / to directories', async () => {
        const { output } = await run(shell, 'ls -F /home');
        expect(output.join(' ')).toMatch(/subdir\//);
    });

    it('-R lists subdirectories recursively', async () => {
        const { output } = await run(shell, 'ls -R /home');
        expect(output.join('\n')).toMatch(/inner\.txt/);
    });
});

describe('test new operators', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: { home: { 'file.txt': 'data', subdir: {} } }
        });
    });

    it('-e returns true for existing file', async () => {
        const { exitCode } = await run(shell, 'test -e /home/file.txt');
        expect(exitCode).toBe(0);
    });

    it('-e returns true for existing directory', async () => {
        const { exitCode } = await run(shell, 'test -e /home/subdir');
        expect(exitCode).toBe(0);
    });

    it('-e returns false for missing path', async () => {
        const { exitCode } = await run(shell, 'test -e /nope');
        expect(exitCode).toBe(1);
    });

    it('-x returns true for executable file', async () => {
        await shell.onCommand('chmod +x /home/file.txt');
        const { exitCode } = await run(shell, 'test -x /home/file.txt');
        expect(exitCode).toBe(0);
    });

    it('-x returns false for non-executable file', async () => {
        const { exitCode } = await run(shell, 'test -x /home/file.txt');
        expect(exitCode).toBe(1);
    });

    it('-a requires both conditions to be true', async () => {
        const { exitCode } = await run(shell, 'test -e /home/file.txt -a -d /home/subdir');
        expect(exitCode).toBe(0);
    });

    it('-a fails if one condition is false', async () => {
        const { exitCode } = await run(shell, 'test -e /home/file.txt -a -d /home/file.txt');
        expect(exitCode).toBe(1);
    });

    it('-o succeeds if either condition is true', async () => {
        const { exitCode } = await run(shell, 'test -e /nope -o -e /home/file.txt');
        expect(exitCode).toBe(0);
    });

    it('-s returns true for non-empty file', async () => {
        const { exitCode } = await run(shell, 'test -s /home/file.txt');
        expect(exitCode).toBe(0);
    });
});

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

    it('errors when reading a file without read permission', async () => {
        const shell = await createShell({
            filesystem: { home: { 'secret.txt': 'private' } },
            permissions: { '/home/secret.txt': 0o000 }
        });
        const { errors, exitCode } = await run(shell, 'cat /home/secret.txt');
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/permission denied/i);
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

describe('grep', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'a.txt': 'hello world\nfoo bar\nHELLO again',
                    'b.txt': 'second file\nfoo baz',
                    subdir: {
                        'c.txt': 'nested foo line'
                    }
                }
            },
            cwd: '/home'
        });
    });

    it('matches a basic pattern', async () => {
        const { output, exitCode } = await run(shell, 'grep foo /home/a.txt');
        expect(output).toContain('foo bar');
        expect(exitCode).toBe(0);
    });

    it('exits 1 when pattern not found', async () => {
        const { exitCode } = await run(shell, 'grep nomatch /home/a.txt');
        expect(exitCode).toBe(1);
    });

    it('-i matches case-insensitively', async () => {
        const { output } = await run(shell, 'grep -i hello /home/a.txt');
        expect(output).toContain('hello world');
        expect(output).toContain('HELLO again');
    });

    it('-v inverts match', async () => {
        const { output } = await run(shell, 'grep -v foo /home/a.txt');
        expect(output).toContain('hello world');
        expect(output).not.toContain('foo bar');
    });

    it('-n prefixes with line numbers', async () => {
        const { output } = await run(shell, 'grep -n foo /home/a.txt');
        expect(output.some(l => l.startsWith('2:'))).toBe(true);
    });

    it('-c prints match count', async () => {
        const { output } = await run(shell, 'grep -c foo /home/a.txt');
        expect(output).toContain('1');
    });

    it('-l lists filenames only for multi-file search', async () => {
        const { output } = await run(shell, 'grep -l foo /home/a.txt /home/b.txt');
        expect(output).toContain('/home/a.txt');
        expect(output).toContain('/home/b.txt');
    });

    it('prefixes filename when multiple files given', async () => {
        const { output } = await run(shell, 'grep foo /home/a.txt /home/b.txt');
        expect(output.some(l => l.startsWith('/home/a.txt:'))).toBe(true);
        expect(output.some(l => l.startsWith('/home/b.txt:'))).toBe(true);
    });

    it('-r searches recursively', async () => {
        const { output } = await run(shell, 'grep -r foo /home');
        expect(output.some(l => l.includes('foo'))).toBe(true);
        expect(output.some(l => l.includes('nested foo line'))).toBe(true);
    });

    it('-F treats pattern as fixed string', async () => {
        const { output } = await run(shell, 'grep -F foo /home/a.txt');
        expect(output).toContain('foo bar');
    });

    it('-e accepts pattern as flag argument', async () => {
        const { output } = await run(shell, 'grep -e foo /home/a.txt');
        expect(output).toContain('foo bar');
    });

    it('errors on missing file with exit code 2', async () => {
        const { errors, exitCode } = await run(shell, 'grep foo /home/missing.txt');
        expect(exitCode).toBe(2);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('errors when no pattern given', async () => {
        const { errors, exitCode } = await run(shell, 'grep');
        expect(exitCode).toBe(2);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('-q suppresses output but still sets exit code', async () => {
        const { output, exitCode } = await run(shell, 'grep -q foo /home/a.txt');
        expect(output.length).toBe(0);
        expect(exitCode).toBe(0);
    });

    it('-- ends option parsing so pattern can start with -', async () => {
        const shell2 = await createShell({
            filesystem: { home: { 'f.txt': '-dashed line\nnormal line' } }
        });
        const { output } = await run(shell2, 'grep -- -dashed /home/f.txt');
        expect(output).toContain('-dashed line');
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
            filesystem: { home: { 'file.txt': 'line1\nline2\nline3\n' } }
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
        shell.context.fs.setFileByPath('/home/file2.txt', 'line4\n');
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

describe('tail', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'nums.txt': '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n',
                    'short.txt': 'a\nb\n',
                    'abc.txt': 'abcdef\n',
                    'empty.txt': ''
                }
            }
        });
    });

    it('prints the last 10 lines by default', async () => {
        const { output } = await run(shell, 'tail /home/nums.txt');
        expect(output).toEqual(['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    });

    it('-n N prints the last N lines', async () => {
        const { output } = await run(shell, 'tail -n 2 /home/nums.txt');
        expect(output).toEqual(['11', '12']);
    });

    it('accepts -nN and legacy -N', async () => {
        expect((await run(shell, 'tail -n3 /home/nums.txt')).output).toEqual(['10', '11', '12']);
        expect((await run(shell, 'tail -1 /home/nums.txt')).output).toEqual(['12']);
    });

    it('-n +N starts at line N', async () => {
        const { output } = await run(shell, 'tail -n +11 /home/nums.txt');
        expect(output).toEqual(['11', '12']);
    });

    it('-n 0 prints nothing', async () => {
        const { output } = await run(shell, 'tail -n 0 /home/nums.txt');
        expect(output).toEqual([]);
    });

    it('prints everything when the file is shorter than N', async () => {
        const { output } = await run(shell, 'tail -n 5 /home/short.txt');
        expect(output).toEqual(['a', 'b']);
    });

    it('-c N prints the last N bytes', async () => {
        const { output } = await run(shell, 'tail -c 4 /home/abc.txt');
        expect(output).toEqual(['def']);
    });

    it('prints nothing for an empty file', async () => {
        const { output } = await run(shell, 'tail /home/empty.txt');
        expect(output).toEqual([]);
    });

    it('reads from a pipe', async () => {
        const { output } = await run(shell, 'cat /home/nums.txt | tail -n 2');
        expect(output).toEqual(['11', '12']);
    });

    it('prints headers for multiple files', async () => {
        const { output } = await run(shell, 'tail -n 1 /home/short.txt /home/abc.txt');
        expect(output).toEqual(['==> /home/short.txt <==', 'b', '', '==> /home/abc.txt <==', 'abcdef']);
    });

    it('errors on a missing file but still reads the others', async () => {
        const { output, errors, exitCode } = await run(shell, 'tail -n 1 /home/nope /home/short.txt');
        expect(errors.join(' ')).toMatch(/nope.*No such file/);
        expect(output).toContain('b');
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors on an invalid count', async () => {
        const { errors, exitCode } = await run(shell, 'tail -n abc /home/short.txt');
        expect(errors.join(' ')).toMatch(/invalid number/);
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('sed', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'f.txt': 'one\ntwo\nthree\nfour\nfive\n',
                    'words.txt': 'foo bar foo baz foo\n'
                }
            }
        });
    });

    const sed = async args => (await run(shell, `sed ${args}`)).output;

    it('substitutes the first match per line', async () => {
        expect(await sed(`'s/foo/X/' /home/words.txt`)).toEqual(['X bar foo baz foo']);
    });

    it('g flag substitutes all matches', async () => {
        expect(await sed(`'s/foo/X/g' /home/words.txt`)).toEqual(['X bar X baz X']);
    });

    it('numeric flag substitutes the Nth match, with g from the Nth on', async () => {
        expect(await sed(`'s/foo/X/2' /home/words.txt`)).toEqual(['foo bar X baz foo']);
        expect(await sed(`'s/foo/X/2g' /home/words.txt`)).toEqual(['foo bar X baz X']);
    });

    it('i flag ignores case', async () => {
        expect(await sed(`'s/FOO/X/i' /home/words.txt`)).toEqual(['X bar foo baz foo']);
    });

    it('supports & and backreferences in the replacement', async () => {
        expect(await sed(`'s/t\\(w\\)o/[&:\\1]/' /home/f.txt`)).toContain('[two:w]');
    });

    it('accepts other delimiters and escaped delimiters', async () => {
        expect((await sed(`'s,o,0,g' /home/f.txt`))[0]).toBe('0ne');
        expect(await sed(`'s/foo/a\\/b/' /home/words.txt`)).toEqual(['a/b bar foo baz foo']);
    });

    it('BRE treats + and ( literally, escaped forms are operators', async () => {
        await shell.onCommand('echo "a+b" > /home/p.txt');
        expect(await sed(`'s/a+b/X/' /home/p.txt`)).toEqual(['X']);
        expect((await sed(`'s/o\\+/0/' /home/f.txt`))[0]).toBe('0ne');
    });

    it('-E uses extended regex', async () => {
        expect((await sed(`-E 's/o+|w/0/' /home/f.txt`))[1]).toBe('t0o');
        expect((await sed(`-E 's/(t)(w)/\\2\\1/' /home/f.txt`))[1]).toBe('wto');
    });

    it('supports POSIX character classes', async () => {
        expect(await sed(`'s/[[:alpha:]]*/X/' /home/words.txt`)).toEqual(['X bar foo baz foo']);
    });

    it('-n with p prints only matching lines', async () => {
        expect(await sed(`-n '/t/p' /home/f.txt`)).toEqual(['two', 'three']);
    });

    it('s///p with -n prints only substituted lines', async () => {
        expect(await sed(`-n 's/o/0/p' /home/f.txt`)).toEqual(['0ne', 'tw0', 'f0ur']);
    });

    it('d deletes lines by number, regex and range', async () => {
        expect(await sed(`'2d' /home/f.txt`)).toEqual(['one', 'three', 'four', 'five']);
        expect(await sed(`'/o/d' /home/f.txt`)).toEqual(['three', 'five']);
        expect(await sed(`'2,4d' /home/f.txt`)).toEqual(['one', 'five']);
    });

    it('$ addresses the last line', async () => {
        expect(await sed(`'$d' /home/f.txt`)).toEqual(['one', 'two', 'three', 'four']);
        expect(await sed(`-n '$p' /home/f.txt`)).toEqual(['five']);
    });

    it('regex ranges start at a match and end at a later match', async () => {
        expect(await sed(`-n '/two/,/four/p' /home/f.txt`)).toEqual(['two', 'three', 'four']);
    });

    it('a numeric end address behind the start is a single line', async () => {
        expect(await sed(`-n '3,1p' /home/f.txt`)).toEqual(['three']);
    });

    it('! negates the address', async () => {
        expect(await sed(`-n '2!p' /home/f.txt`)).toEqual(['one', 'three', 'four', 'five']);
    });

    it('q quits after printing the current line', async () => {
        expect(await sed(`'2q' /home/f.txt`)).toEqual(['one', 'two']);
    });

    it('= prints line numbers', async () => {
        expect(await sed(`-n '$=' /home/f.txt`)).toEqual(['5']);
    });

    it('y transliterates characters', async () => {
        expect((await sed(`'y/on/ON/' /home/f.txt`))[0]).toBe('ONe');
    });

    it('runs multiple -e scripts and ; separated commands in order', async () => {
        expect((await sed(`-e '1d' -e 's/o/0/' /home/f.txt`))[0]).toBe('tw0');
        expect((await sed(`'1d;s/o/0/' /home/f.txt`))[0]).toBe('tw0');
    });

    it('reads from a pipe', async () => {
        const { output } = await run(shell, 'cat /home/f.txt | sed -n 2p');
        expect(output).toEqual(['two']);
    });

    it('an empty regex reuses the last one', async () => {
        expect((await sed(`'/two/s//2/' /home/f.txt`))[1]).toBe('2');
    });

    it('errors on an unknown command', async () => {
        const { errors, exitCode } = await run(shell, `sed 'k' /home/f.txt`);
        expect(errors.join(' ')).toMatch(/unknown command/);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors on an unterminated s command', async () => {
        const { errors, exitCode } = await run(shell, `sed 's/a/b' /home/f.txt`);
        expect(errors.join(' ')).toMatch(/unterminated/);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors without a script', async () => {
        const { errors, exitCode } = await run(shell, 'sed');
        expect(errors.join(' ')).toMatch(/usage/);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors on a missing file', async () => {
        const { errors, exitCode } = await run(shell, `sed p /home/nope`);
        expect(errors.join(' ')).toMatch(/No such file/);
        expect(exitCode).toBeGreaterThan(0);
    });
});

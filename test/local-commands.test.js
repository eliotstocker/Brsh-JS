import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

describe('export', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('sets an environment variable', async () => {
        await shell.onCommand('export MYVAR=hello');
        expect(shell.context.getVar('MYVAR')).toBe('hello');
    });

    it('allows reading the variable via echo', async () => {
        await shell.onCommand('export GREETING=hi');
        const { output } = await run(shell, 'echo $GREETING');
        expect(output).toContain('hi');
    });

    it('errors without an argument', async () => {
        const { exitCode } = await run(shell, 'export');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('alias', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('creates an alias that executes the mapped command', async () => {
        // Use quotes so the full "echo hello" is treated as the alias value
        await shell.onCommand("alias 'greet=echo hello'");
        const { output } = await run(shell, 'greet');
        expect(output).toContain('hello');
    });

    it('errors without a key=value pair', async () => {
        const { exitCode } = await run(shell, 'alias noequals');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('cd', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: { home: { user: {} } }
        });
    });

    it('changes to an absolute directory', async () => {
        await shell.onCommand('cd /home');
        expect(shell.context.fs.cwd).toBe('/home/');
    });

    it('changes to a nested directory', async () => {
        await shell.onCommand('cd /home/user');
        expect(shell.context.fs.cwd).toBe('/home/user/');
    });

    it('navigates up with ..', async () => {
        await shell.onCommand('cd /home/user');
        await shell.onCommand('cd ..');
        expect(shell.context.fs.cwd).toBe('/home/');
    });

    it('errors on a non-existent directory', async () => {
        const { errors, exitCode } = await run(shell, 'cd /does/not/exist');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors when target is a file not a directory', async () => {
        const s = await createShell({ filesystem: { home: { 'file.txt': 'data' } } });
        const { errors, exitCode } = await run(s, 'cd /home/file.txt');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors without an argument', async () => {
        const { exitCode } = await run(shell, 'cd');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('clear', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('emits a clear event', () => {
        return new Promise((resolve) => {
            shell.once('clear', resolve);
            shell.onCommand('clear');
        });
    });

    it('errors with unexpected arguments', async () => {
        const { exitCode } = await run(shell, 'clear extra');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('exit', () => {
    it('destroys the shell and emits exit with code 0', async () => {
        const shell = await createShell();
        return new Promise((resolve) => {
            shell.once('exit', (code) => {
                expect(code).toBe(0);
                resolve();
            });
            shell.onCommand('exit');
        });
    });

    it('exits with a specific code', async () => {
        const shell = await createShell();
        return new Promise((resolve) => {
            shell.once('exit', (code) => {
                expect(code).toBe(42);
                resolve();
            });
            shell.onCommand('exit 42');
        });
    });
});

describe('which', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('finds a built-in command and returns exit code 0', async () => {
        const { exitCode } = await run(shell, 'which echo');
        expect(exitCode).toBe(0);
    });

    it('outputs the full path for a found command', async () => {
        const { output } = await run(shell, 'which echo');
        expect(output.join(' ')).toMatch(/\/bin\/echo/);
    });

    it('returns non-zero for an unknown command', async () => {
        const { exitCode } = await run(shell, 'which nothinghere');
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors without an argument', async () => {
        const { exitCode } = await run(shell, 'which');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('read', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('streams a prompt before waiting for input', () => {
        return new Promise((resolve, reject) => {
            const tid = setTimeout(() => reject(new Error('prompt not received')), 500);
            shell.once('stdErr', (line) => {
                clearTimeout(tid);
                expect(line).toBe('enter value: ');
                shell.onInput('a');
                shell.onInput('b');
                shell.onInput('c');
                resolve();
            });
            shell.onCommand('read -p "enter value: " -n 3 INPUT');
        });
    });

    it('stores received characters in the named variable', async () => {
        const p = shell.onCommand('read -n 1 -t 1 CHAR');
        // _runCommand is async so drain all microtasks before sending input
        await new Promise(resolve => setImmediate(resolve));
        shell.onInput('x');
        await p;
        expect(shell.context.getVar('CHAR')).toBe('x');
    });

    it('shows help with -h', async () => {
        const { output } = await run(shell, 'read -h');
        expect(output.join(' ')).toMatch(/usage/i);
    });
});

describe('source', () => {
    it('executes a script and merges exported variables into the current context', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: { 'setup.sh': '#!/sh.js\nexport LOADED=yes' }
            }
        });
        await shell.onCommand('source /scripts/setup.sh');
        expect(shell.context.getVar('LOADED')).toBe('yes');
    });

    it('sourced aliases are available in the current context', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: { 'aliases.sh': "#!/sh.js\nalias 'greet=echo hi'" }
            }
        });
        await shell.onCommand('source /scripts/aliases.sh');
        const { output } = await run(shell, 'greet');
        expect(output).toContain('hi');
    });

    it('errors on a non-existent file', async () => {
        const shell = await createShell();
        const { errors, exitCode } = await run(shell, 'source /nope.sh');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('errors when the target has no shebang', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: { 'plain.sh': 'just text, no shebang' }
            }
        });
        const { exitCode } = await run(shell, 'source /scripts/plain.sh');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('chmod', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'script.sh': '#!/bin/sh\necho hello',
                    'readme.txt': 'just text'
                }
            },
            cwd: '/home'
        });
    });

    it('sets octal mode on a file', async () => {
        await shell.onCommand('chmod 755 /home/script.sh');
        expect(shell.context.fs.getMode('/home/script.sh')).toBe(0o755);
    });

    it('sets a 3-digit octal mode', async () => {
        await shell.onCommand('chmod 644 /home/script.sh');
        expect(shell.context.fs.getMode('/home/script.sh')).toBe(0o644);
    });

    it('adds execute bit with +x', async () => {
        await shell.onCommand('chmod 644 /home/script.sh');
        await shell.onCommand('chmod +x /home/script.sh');
        const mode = shell.context.fs.getMode('/home/script.sh');
        expect(mode & 0o100).toBeTruthy();
    });

    it('removes execute bit with -x', async () => {
        await shell.onCommand('chmod 755 /home/script.sh');
        await shell.onCommand('chmod -x /home/script.sh');
        const mode = shell.context.fs.getMode('/home/script.sh');
        expect(mode & 0o111).toBe(0);
    });

    it('adds read bit with u+r', async () => {
        await shell.onCommand('chmod 000 /home/readme.txt');
        await shell.onCommand('chmod u+r /home/readme.txt');
        const mode = shell.context.fs.getMode('/home/readme.txt');
        expect(mode & 0o400).toBeTruthy();
    });

    it('errors on invalid mode', async () => {
        const { errors, exitCode } = await run(shell, 'chmod badmode /home/script.sh');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/invalid mode/i);
    });

    it('errors when file does not exist', async () => {
        const { errors, exitCode } = await run(shell, 'chmod 755 /home/nope.sh');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/No such file/i);
    });

    it('errors with no arguments', async () => {
        const { errors, exitCode } = await run(shell, 'chmod');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/usage/i);
    });

    it('allows running a script after chmod +x', async () => {
        const { output, exitCode } = await run(shell, './script.sh');
        expect(exitCode).toBeGreaterThan(0);

        await shell.onCommand('chmod +x /home/script.sh');
        const { output: out2, exitCode: code2 } = await run(shell, './script.sh');
        expect(code2).toBe(0);
        expect(out2).toContain('hello');
    });

    it('blocks execution of a script without execute permission', async () => {
        const { errors, exitCode } = await run(shell, './script.sh');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/permission denied/i);
    });
});

describe('pwd', () => {
    it('prints the current working directory', async () => {
        const shell = await createShell({ cwd: '/home' });
        const { output } = await run(shell, 'pwd');
        expect(output).toContain('/home');
    });

    it('prints / at root', async () => {
        const shell = await createShell({ cwd: '/' });
        const { output } = await run(shell, 'pwd');
        expect(output).toContain('/');
    });

    it('reflects cd changes', async () => {
        const shell = await createShell({
            filesystem: { home: { user: {} } },
            cwd: '/'
        });
        await shell.onCommand('cd /home/user');
        const { output } = await run(shell, 'pwd');
        expect(output).toContain('/home/user');
    });
});

describe('mkdir', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({ filesystem: { home: {} }, cwd: '/home' });
    });

    it('creates a new directory', async () => {
        await run(shell, 'mkdir /home/newdir');
        const dir = shell.context.fs.getFileByPath('/home/newdir');
        expect(dir).toBeDefined();
        expect(dir.constructor).toBe(Object);
    });

    it('-p creates parent directories', async () => {
        await run(shell, 'mkdir -p /home/a/b/c');
        const dir = shell.context.fs.getFileByPath('/home/a/b/c');
        expect(dir).toBeDefined();
    });

    it('-p does not error if directory already exists', async () => {
        const { exitCode } = await run(shell, 'mkdir -p /home');
        expect(exitCode).toBe(0);
    });

    it('errors if directory exists without -p', async () => {
        const { exitCode, errors } = await run(shell, 'mkdir /home');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/File exists/i);
    });

    it('errors with no arguments', async () => {
        const { exitCode } = await run(shell, 'mkdir');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('rm', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'file.txt': 'hello',
                    subdir: { 'inner.txt': 'inner' }
                }
            }
        });
    });

    it('removes a file', async () => {
        await run(shell, 'rm /home/file.txt');
        expect(shell.context.fs.getFileByPath('/home/file.txt')).toBeNull();
    });

    it('errors when removing a directory without -r', async () => {
        const { exitCode, errors } = await run(shell, 'rm /home/subdir');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/Is a directory/i);
    });

    it('-r removes a directory recursively', async () => {
        await run(shell, 'rm -r /home/subdir');
        expect(shell.context.fs.getFileByPath('/home/subdir')).toBeNull();
    });

    it('-f does not error on missing file', async () => {
        const { exitCode } = await run(shell, 'rm -f /home/nope.txt');
        expect(exitCode).toBe(0);
    });

    it('errors on missing file without -f', async () => {
        const { exitCode } = await run(shell, 'rm /home/nope.txt');
        expect(exitCode).toBeGreaterThan(0);
    });

    it('fires onChange after deleting a file', async () => {
        const changes = [];
        const shell2 = await createShell({
            filesystem: { home: { 'file.txt': 'hello' } },
            onFsChange: (fs) => changes.push(Object.keys(fs.home || {}))
        });
        await run(shell2, 'rm /home/file.txt');
        // Wait for microtask to fire
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(changes.length).toBeGreaterThan(0);
        expect(changes[changes.length - 1]).not.toContain('file.txt');
    });
});

describe('mv', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: { home: { 'file.txt': 'hello', dest: {} } }
        });
    });

    it('renames a file', async () => {
        await run(shell, 'mv /home/file.txt /home/renamed.txt');
        expect(shell.context.fs.getFileByPath('/home/renamed.txt')).toBe('hello');
        expect(shell.context.fs.getFileByPath('/home/file.txt')).toBeNull();
    });

    it('moves a file into a directory', async () => {
        await run(shell, 'mv /home/file.txt /home/dest');
        expect(shell.context.fs.getFileByPath('/home/dest/file.txt')).toBe('hello');
        expect(shell.context.fs.getFileByPath('/home/file.txt')).toBeNull();
    });

    it('errors on missing source', async () => {
        const { exitCode } = await run(shell, 'mv /home/nope.txt /home/dest');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('cp', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {
                    'file.txt': 'hello',
                    subdir: { 'inner.txt': 'inner' },
                    dest: {}
                }
            }
        });
    });

    it('copies a file', async () => {
        await run(shell, 'cp /home/file.txt /home/copy.txt');
        expect(shell.context.fs.getFileByPath('/home/copy.txt')).toBe('hello');
        expect(shell.context.fs.getFileByPath('/home/file.txt')).toBe('hello');
    });

    it('copies a file into a directory', async () => {
        await run(shell, 'cp /home/file.txt /home/dest');
        expect(shell.context.fs.getFileByPath('/home/dest/file.txt')).toBe('hello');
    });

    it('-r copies a directory recursively', async () => {
        await run(shell, 'cp -r /home/subdir /home/subdircopy');
        expect(shell.context.fs.getFileByPath('/home/subdircopy/inner.txt')).toBe('inner');
    });

    it('errors when copying directory without -r', async () => {
        const { exitCode, errors } = await run(shell, 'cp /home/subdir /home/dest2');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/-r/i);
    });

    it('errors on missing source', async () => {
        const { exitCode } = await run(shell, 'cp /home/nope.txt /home/dest');
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('onFsChange callback', () => {
    it('fires when a file is created via mkdir', async () => {
        const calls = [];
        const shell = await createShell({
            filesystem: { home: {} },
            onFsChange: (fs) => calls.push(fs)
        });
        await run(shell, 'mkdir /home/newdir');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(calls.length).toBeGreaterThan(0);
        const last = calls[calls.length - 1];
        expect(last.home.newdir).toBeDefined();
    });

    it('fires with updated permissions after chmod', async () => {
        const calls = [];
        const shell = await createShell({
            filesystem: { home: { 'f.txt': 'x' } },
            onFsChange: (fs, perms) => calls.push(perms)
        });
        await run(shell, 'chmod 755 /home/f.txt');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[calls.length - 1]['/home/f.txt']).toBe(0o755);
    });

    it('does not fire in subshells (command substitution)', async () => {
        const calls = [];
        const shell = await createShell({
            onFsChange: () => calls.push(1)
        });
        // Command substitution runs in a subshell — should not trigger parent callback
        const beforeLen = calls.length;
        await run(shell, 'echo $(echo hello)');
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(calls.length).toBe(beforeLen);
    });
});

describe('jsfunction', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('defines and calls a no-arg function', async () => {
        await shell.onCommand("jsfunction hi 'args => \"hello world\"'");
        const { output, exitCode } = await run(shell, 'hi');
        expect(output).toContain('hello world');
        expect(exitCode).toBe(0);
    });

    it('passes arguments to the function', async () => {
        await shell.onCommand("jsfunction greet 'args => \"Hello \" + args[0]'");
        const { output } = await run(shell, 'greet Alice');
        expect(output).toContain('Hello Alice');
    });

    it('returning undefined produces no output and exits 0', async () => {
        await shell.onCommand("jsfunction noop 'args => undefined'");
        const { output, exitCode } = await run(shell, 'noop');
        expect(output.length).toBe(0);
        expect(exitCode).toBe(0);
    });

    it('invalid JS body gives stderr and exit code 1', async () => {
        const { errors, exitCode } = await run(shell, 'jsfunction bad "{{{"');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBe(1);
    });

    it('non-function expression gives stderr and exit code 1', async () => {
        const { errors, exitCode } = await run(shell, 'jsfunction notfn \'"hello"\'');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBe(1);
    });

    it('runtime error in function gives stderr and exit code 1', async () => {
        await shell.onCommand("jsfunction boom 'args => { throw new Error(\"boom\"); }'");
        const { errors, exitCode } = await run(shell, 'boom');
        expect(errors.join(' ')).toMatch(/boom/);
        expect(exitCode).toBe(1);
    });

    it('missing arguments gives usage error', async () => {
        const { errors, exitCode } = await run(shell, 'jsfunction');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBe(1);
    });

    it('async function return value is captured', async () => {
        await shell.onCommand("jsfunction asynchi 'args => Promise.resolve(\"async result\")'");
        const { output, exitCode } = await run(shell, 'asynchi');
        expect(output).toContain('async result');
        expect(exitCode).toBe(0);
    });

    it('can be defined and used within a script', async () => {
        const scriptShell = await createShell({
            filesystem: {
                scripts: {
                    'fn.sh': '#!/sh.js\njsfunction double \'args => String(Number(args[0]) * 2)\'\necho $(double 5)'
                }
            },
            permissions: { '/scripts/fn.sh': 0o755 }
        });
        const { output } = await run(scriptShell, '/scripts/fn.sh');
        expect(output).toContain('10');
    });
});

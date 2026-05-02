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

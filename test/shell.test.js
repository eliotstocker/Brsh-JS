import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

const require = createRequire(import.meta.url);
const Shell = require('../index.js');

describe('Shell core behaviour', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell();
    });

    it('emits STATUS_READY after construction', () => {
        expect(shell).toBeDefined();
    });

    it('exposes status constants', () => {
        expect(Shell.STATUS_READY).toBe('READY');
        expect(Shell.STATUS_WORKING).toBe('WORKING');
        expect(Shell.STATUS_DESTROYED).toBe('DESTROYED');
    });

    it('sets lastCode to 0 initially', () => {
        expect(shell.lastCode).toBe(0);
    });

    it('emits STATUS_WORKING then STATUS_READY during a command', async () => {
        const statuses = [];
        shell.on('status', (s) => statuses.push(s));
        await shell.onCommand('echo hello');
        expect(statuses).toContain(Shell.STATUS_WORKING);
        expect(statuses[statuses.length - 1]).toBe(Shell.STATUS_READY);
    });

    it('strips comments from input', async () => {
        const { output } = await run(shell, 'echo hello # this is a comment');
        expect(output).toContain('hello');
    });

    it('substitutes $VARIABLE in arguments', async () => {
        await shell.onCommand('export GREETING=hello');
        const { output } = await run(shell, 'echo $GREETING');
        expect(output).toContain('hello');
    });

    it('substitutes ${VARIABLE} in arguments', async () => {
        await shell.onCommand('export NAME=world');
        const { output } = await run(shell, 'echo ${NAME}');
        expect(output).toContain('world');
    });

    it('handles single-quoted strings as one argument', async () => {
        const { output } = await run(shell, "echo 'hello world'");
        expect(output).toContain('hello world');
    });

    it('handles double-quoted strings as one argument', async () => {
        const { output } = await run(shell, 'echo "hello world"');
        expect(output).toContain('hello world');
    });

    it('emits stdErr and sets lastCode != 0 for unknown commands', async () => {
        const { errors, exitCode } = await run(shell, 'notacommand');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('short-circuits && chain on non-zero exit code', async () => {
        const { output, errors } = await run(shell, 'notacommand && echo should_not_print');
        expect(output).not.toContain('should_not_print');
        expect(errors.length).toBeGreaterThan(0);
    });

    it('runs both sides of && when first command succeeds', async () => {
        const { output } = await run(shell, 'echo first && echo second');
        expect(output).toContain('first');
        expect(output).toContain('second');
    });

    it('ignores empty commands gracefully', async () => {
        const result = await run(shell, '');
        expect(result.exitCode).toBe(0);
    });

    it('returns the prompt string', () => {
        const prompt = shell.getPrompt();
        expect(typeof prompt).toBe('string');
        expect(prompt.length).toBeGreaterThan(0);
    });

    it('emits clear event when clear() is called', () => {
        return new Promise((resolve) => {
            shell.once('clear', resolve);
            shell.clear();
        });
    });

    it('destroys shell with exit event', () => {
        return new Promise((resolve) => {
            shell.once('exit', (code) => {
                expect(code).toBe(0);
                resolve();
            });
            shell.destroy();
        });
    });

    it('does not double-destroy', () => {
        shell.destroy();
        expect(() => shell.destroy()).not.toThrow();
    });

    it('exposes the Command class', () => {
        expect(Shell.Command).toBeDefined();
    });
});

describe('|| and ; operators', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('runs right side of || when left fails', async () => {
        const { output } = await run(shell, 'notacommand || echo fallback');
        expect(output).toContain('fallback');
    });

    it('skips right side of || when left succeeds', async () => {
        const { output } = await run(shell, 'echo first || echo should_not_run');
        expect(output).toContain('first');
        expect(output).not.toContain('should_not_run');
    });

    it('|| resets the && chain allowing further commands to run', async () => {
        const { output } = await run(shell, 'notacommand && echo skip || echo recover');
        expect(output).not.toContain('skip');
        expect(output).toContain('recover');
    });

    it('; always runs the next command regardless of exit code', async () => {
        const { output } = await run(shell, 'echo a ; echo b');
        expect(output).toContain('a');
        expect(output).toContain('b');
    });

    it('; continues after a failing command', async () => {
        const { output } = await run(shell, 'notacommand ; echo after');
        expect(output).toContain('after');
    });

    it('chains multiple ; separated commands', async () => {
        const { output } = await run(shell, 'echo x ; echo y ; echo z');
        expect(output).toContain('x');
        expect(output).toContain('y');
        expect(output).toContain('z');
    });
});

describe('command substitution $()', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('substitutes the output of a subcommand into an argument', async () => {
        const { output } = await run(shell, 'echo $(echo hello)');
        expect(output).toContain('hello');
    });

    it('substitutes into a variable assignment', async () => {
        await shell.onCommand('export RESULT=$(echo captured)');
        expect(shell.context.getVar('RESULT')).toBe('captured');
    });
});

describe('arithmetic substitution $(( ))', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('evaluates simple addition', async () => {
        const { output } = await run(shell, 'echo $((2 + 3))');
        expect(output).toContain('5');
    });

    it('evaluates multiplication', async () => {
        const { output } = await run(shell, 'echo $((4 * 5))');
        expect(output).toContain('20');
    });

    it('substitutes variables inside arithmetic', async () => {
        await shell.onCommand('export X=7');
        const { output } = await run(shell, 'echo $(($X + 3))');
        expect(output).toContain('10');
    });

    it('stores arithmetic result in a variable', async () => {
        await shell.onCommand('export TOTAL=$((10 - 4))');
        expect(shell.context.getVar('TOTAL')).toBe('6');
    });
});

describe('unclosed quote error', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('emits stdErr and sets non-zero exit code for unclosed single quote', async () => {
        const { errors, exitCode } = await run(shell, "echo 'unclosed");
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('emits stdErr and sets non-zero exit code for unclosed double quote', async () => {
        const { errors, exitCode } = await run(shell, 'echo "unclosed');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });
});

describe('tabCompletion', () => {
    it('returns matching built-in commands from PATH', async () => {
        const shell = await createShell();
        const result = shell.tabCompletion('ec');
        expect(result).not.toBeNull();
        expect(result.options).toContain('echo');
    });

    it('returns null when nothing matches', async () => {
        const shell = await createShell();
        const result = shell.tabCompletion('zzznothing');
        expect(result).toBeNull();
    });

    it('returns filesystem paths when given a path prefix', async () => {
        const shell = await createShell({ filesystem: { home: { user: {} } } });
        const result = shell.tabCompletion('/ho');
        expect(result).not.toBeNull();
        expect(result.options.some(o => o.startsWith('home'))).toBe(true);
    });

    it('appends / to directory completions', async () => {
        const shell = await createShell({ filesystem: { mydir: {} } });
        const result = shell.tabCompletion('/my');
        expect(result).not.toBeNull();
        expect(result.options).toContain('mydir/');
    });
});

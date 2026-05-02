import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

// Use createRequire so these CJS modules share the same module cache as
// index.js's internal require() calls — ensuring instanceof checks work.
const require = createRequire(import.meta.url);
const Shell = require('../index.js');
const Command = require('../lib/Command.js');

// ---------------------------------------------------------------------------
// JS application from filesystem
// ---------------------------------------------------------------------------

class HelloApp extends Command {
    get name() { return 'hello-app'; }
    run() { return Promise.resolve('Hello from JS app'); }
}

class GreeterApp extends Command {
    get name() { return 'greeter'; }
    run() {
        const name = this.arguments[0] || 'World';
        return Promise.resolve(`Hello, ${name}!`);
    }
}

class FailingApp extends Command {
    get name() { return 'failing-app'; }
    run() { return Promise.reject(new Error('App crashed')); }
}

describe('JS application from filesystem', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                apps: {
                    hello: HelloApp,
                    greeter: GreeterApp,
                    failing: FailingApp
                }
            }
        });
    });

    it('runs a Command class stored at an absolute path', async () => {
        const { output } = await run(shell, '/apps/hello');
        expect(output).toContain('Hello from JS app');
    });

    it('runs a Command class stored at a relative path (./)', async () => {
        const { output } = await run(shell, './apps/hello');
        expect(output).toContain('Hello from JS app');
    });

    it('passes arguments to the application', async () => {
        const { output } = await run(shell, './apps/greeter Alice');
        expect(output).toContain('Hello, Alice!');
    });

    it('surfaces an application error as stderr', async () => {
        const { errors, exitCode } = await run(shell, './apps/failing');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors when the path does not exist', async () => {
        const { errors, exitCode } = await run(shell, './apps/ghost');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors when the path targets a directory', async () => {
        const { errors, exitCode } = await run(shell, './apps');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Shell scripts
// ---------------------------------------------------------------------------

describe('shell script execution', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                scripts: {
                    'greet.sh': '#!/sh.js\necho "Hello Script"',
                    'multi.sh': '#!/sh.js\necho line1\necho line2',
                    'nointerp.sh': 'this has no shebang'
                }
            }
        });
    });

    it('runs a single-command script via absolute path', async () => {
        const { output } = await run(shell, '/scripts/greet.sh');
        expect(output).toContain('Hello Script');
    });

    it('runs a script via relative path (./)', async () => {
        const { output } = await run(shell, './scripts/greet.sh');
        expect(output).toContain('Hello Script');
    });

    it('executes multiple commands in a script', async () => {
        const { output } = await run(shell, '/scripts/multi.sh');
        expect(output).toContain('line1');
        expect(output).toContain('line2');
    });

    it('errors when file has no interpreter shebang', async () => {
        const { exitCode } = await run(shell, '/scripts/nointerp.sh');
        expect(exitCode).toBeGreaterThan(0);
    });

    it('errors when script file does not exist', async () => {
        const { errors, exitCode } = await run(shell, '/scripts/ghost.sh');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Conditional execution via &&
// ---------------------------------------------------------------------------

describe('conditional execution', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('runs both commands when first succeeds (&&)', async () => {
        const { output } = await run(shell, 'echo a && echo b');
        expect(output).toContain('a');
        expect(output).toContain('b');
    });

    it('stops chain after first failure (&&)', async () => {
        const { output } = await run(shell, 'notacommand && echo should_not_run');
        expect(output).not.toContain('should_not_run');
    });

    it.todo('if command: runs then-branch on success');
    it.todo('if command: runs else-branch on failure');
    it.todo('while command: loops until condition is false');
});

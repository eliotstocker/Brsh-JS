import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell, run } from './helpers.js';

// Use createRequire so these CJS modules share the same module cache as
// index.js's internal require() calls — ensuring instanceof checks work.
const require = createRequire(import.meta.url);
const Shell = require('../index.js');
const Command = require('../lib/Command.js');

// Returns a permissions map granting execute (0o755) to the given virtual paths.
function execPerms(...paths) {
    return Object.fromEntries(paths.map(p => [p, 0o755]));
}

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
            },
            permissions: execPerms('/scripts/greet.sh', '/scripts/multi.sh')
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

    it('passes positional parameters to a script', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'args.sh': '#!/bin/sh\necho 1: $1\necho 2: $2\necho count: $#\necho all: $@\n'
                }
            },
            permissions: { '/scripts/args.sh': 0o755 }
        });
        const { output } = await run(shell, '/scripts/args.sh "hello world" test');
        expect(output).toContain('1: hello world');
        expect(output).toContain('2: test');
        expect(output).toContain('count: 2');
        expect(output).toContain('all: hello world test');
    });

    it('forwards "$@" to subcommands within a script', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'forward.sh': '#!/bin/sh\necho "$@"\n'
                }
            },
            permissions: { '/scripts/forward.sh': 0o755 }
        });
        const { output } = await run(shell, '/scripts/forward.sh "quoted string"');
        expect(output).toContain('quoted string');
    });
});

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

describe('execute permission enforcement', () => {
    const SCRIPT = '#!/sh.js\necho ran';

    it('refuses to run a script without execute permission', async () => {
        const shell = await createShell({
            filesystem: { scripts: { 'nox.sh': SCRIPT } },
            permissions: { '/scripts/nox.sh': 0o644 }
        });
        const { errors, exitCode } = await run(shell, '/scripts/nox.sh');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('runs a script that has execute permission', async () => {
        const shell = await createShell({
            filesystem: { scripts: { 'withx.sh': SCRIPT } },
            permissions: { '/scripts/withx.sh': 0o755 }
        });
        const { output, exitCode } = await run(shell, '/scripts/withx.sh');
        expect(output).toContain('ran');
        expect(exitCode).toBe(0);
    });

    it('refuses to run a script when only owner-execute bit is cleared (0o644)', async () => {
        const shell = await createShell({
            filesystem: { scripts: { 'nox2.sh': SCRIPT } },
            permissions: { '/scripts/nox2.sh': 0o644 }
        });
        const { errors, exitCode } = await run(shell, '/scripts/nox2.sh');
        expect(errors.length).toBeGreaterThan(0);
        expect(exitCode).toBeGreaterThan(0);
    });

    it('runs a Command class that has no explicit permission entry (defaults to executable)', async () => {
        const shell = await createShell({
            filesystem: { apps: { hello: HelloApp } }
        });
        const { output, exitCode } = await run(shell, '/apps/hello');
        expect(output).toContain('Hello from JS app');
        expect(exitCode).toBe(0);
    });

    it('refuses to run a Command class with explicit non-executable permission', async () => {
        const shell = await createShell({
            filesystem: { apps: { hello: HelloApp } },
            permissions: { '/apps/hello': 0o644 }
        });
        const { errors, exitCode } = await run(shell, '/apps/hello');
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
});

// ---------------------------------------------------------------------------
// Control flow: if / else / elif / while / for
// ---------------------------------------------------------------------------

describe('if / else / elif', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                scripts: {
                    'if-then.sh': '#!/sh.js\nif true; then\necho yes\nfi',
                    'if-else.sh': '#!/sh.js\nif false; then\necho yes\nelse\necho no\nfi',
                    'if-elif.sh': '#!/sh.js\nexport V=b\nif [ "$V" = "a" ]; then\necho isa\nelif [ "$V" = "b" ]; then\necho isb\nelse\necho isc\nfi',
                    'if-nested.sh': '#!/sh.js\nif true; then\nif true; then\necho inner\nfi\nfi',
                    'if-var.sh': '#!/sh.js\nexport X=hello\nif [ "$X" = "hello" ]; then\necho matched\nfi',
                }
            },
            permissions: execPerms(
                '/scripts/if-then.sh', '/scripts/if-else.sh', '/scripts/if-elif.sh',
                '/scripts/if-nested.sh', '/scripts/if-var.sh'
            )
        });
    });

    it('runs then-branch when condition succeeds', async () => {
        const { output } = await run(shell, '/scripts/if-then.sh');
        expect(output).toContain('yes');
    });

    it('runs else-branch when condition fails', async () => {
        const { output } = await run(shell, '/scripts/if-else.sh');
        expect(output).not.toContain('yes');
        expect(output).toContain('no');
    });

    it('runs the matching elif branch', async () => {
        const { output } = await run(shell, '/scripts/if-elif.sh');
        expect(output).toContain('isb');
        expect(output).not.toContain('isa');
        expect(output).not.toContain('isc');
    });

    it('supports nested if blocks', async () => {
        const { output } = await run(shell, '/scripts/if-nested.sh');
        expect(output).toContain('inner');
    });

    it('uses [ ] test to check a variable', async () => {
        const { output } = await run(shell, '/scripts/if-var.sh');
        expect(output).toContain('matched');
    });
});

describe('while loop', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                scripts: {
                    'while-count.sh': '#!/sh.js\nexport I=0\nwhile [ "$I" != "3" ]; do\nexport I=$(($I + 1))\ndone\necho $I',
                    'while-skip.sh': '#!/sh.js\nif false; then\nwhile true; do\necho infinite\ndone\nfi\necho done',
                }
            },
            permissions: execPerms('/scripts/while-count.sh', '/scripts/while-skip.sh')
        });
    });

    it('loops until condition becomes false', async () => {
        const { output } = await run(shell, '/scripts/while-count.sh');
        expect(output).toContain('3');
    });

    it('skips a while block when inside a false if branch', async () => {
        const { output } = await run(shell, '/scripts/while-skip.sh');
        expect(output).toContain('done');
        expect(output).not.toContain('infinite');
    });
});

describe('for loop', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                scripts: {
                    'for-list.sh': '#!/sh.js\nfor item in apple banana cherry; do\necho $item\ndone',
                    'for-var.sh': '#!/sh.js\nexport ITEMS="x y z"\nfor i in $ITEMS; do\necho $i\ndone',
                    'for-nested.sh': '#!/sh.js\nfor a in 1 2; do\nfor b in x y; do\necho $a$b\ndone\ndone',
                }
            },
            permissions: execPerms('/scripts/for-list.sh', '/scripts/for-var.sh', '/scripts/for-nested.sh')
        });
    });

    it('iterates over a literal list', async () => {
        const { output } = await run(shell, '/scripts/for-list.sh');
        expect(output).toContain('apple');
        expect(output).toContain('banana');
        expect(output).toContain('cherry');
    });

    it('iterates in order', async () => {
        const { output } = await run(shell, '/scripts/for-list.sh');
        expect(output.indexOf('apple')).toBeLessThan(output.indexOf('banana'));
        expect(output.indexOf('banana')).toBeLessThan(output.indexOf('cherry'));
    });

    it('expands a variable to build the list', async () => {
        const { output } = await run(shell, '/scripts/for-var.sh');
        expect(output).toContain('x');
        expect(output).toContain('y');
        expect(output).toContain('z');
    });

    it('supports nested for loops', async () => {
        const { output } = await run(shell, '/scripts/for-nested.sh');
        expect(output).toContain('1x');
        expect(output).toContain('2y');
    });
});

describe('break and continue', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                scripts: {
                    'while-break.sh': '#!/sh.js\nI=0\nwhile true; do\nI=$((I+1))\nif [ $I -eq 3 ]; then\nbreak\nfi\necho $I\ndone\necho done',
                    'for-break.sh': '#!/sh.js\nfor x in a b c d; do\nif [ $x = c ]; then\nbreak\nfi\necho $x\ndone\necho end',
                    'for-continue.sh': '#!/sh.js\nfor x in 1 2 3 4 5; do\nif [ $x = 3 ]; then\ncontinue\nfi\necho $x\ndone',
                    'nested-break.sh': '#!/sh.js\nfor a in 1 2; do\nfor b in x y z; do\nif [ $b = y ]; then\nbreak\nfi\necho $a$b\ndone\ndone',
                }
            },
            permissions: execPerms(
                '/scripts/while-break.sh',
                '/scripts/for-break.sh',
                '/scripts/for-continue.sh',
                '/scripts/nested-break.sh'
            )
        });
    });

    it('break exits a while loop early', async () => {
        const { output } = await run(shell, '/scripts/while-break.sh');
        expect(output).toContain('1');
        expect(output).toContain('2');
        expect(output).not.toContain('3');
        expect(output).toContain('done');
    });

    it('break exits a for loop early', async () => {
        const { output } = await run(shell, '/scripts/for-break.sh');
        expect(output).toContain('a');
        expect(output).toContain('b');
        expect(output).not.toContain('c');
        expect(output).not.toContain('d');
        expect(output).toContain('end');
    });

    it('continue skips the current iteration', async () => {
        const { output } = await run(shell, '/scripts/for-continue.sh');
        expect(output).toContain('1');
        expect(output).toContain('2');
        expect(output).not.toContain('3');
        expect(output).toContain('4');
        expect(output).toContain('5');
    });

    it('break only exits the innermost loop', async () => {
        const { output } = await run(shell, '/scripts/nested-break.sh');
        expect(output).toContain('1x');
        expect(output).toContain('2x');
        expect(output).not.toContain('1y');
        expect(output).not.toContain('2y');
    });
});

describe('sequential script execution', () => {
    it('pipe output appears before the next script line runs', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'pipe-seq.sh': '#!/sh.js\necho first | cat\necho second'
                }
            },
            permissions: execPerms('/scripts/pipe-seq.sh')
        });
        const output = [];
        shell.on('stdOut', l => output.push(l));
        await shell.onCommand('/scripts/pipe-seq.sh', false);
        expect(output.indexOf('first')).toBeLessThan(output.indexOf('second'));
    });

    it('loop iterations run in order when body contains a pipe', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'loop-pipe.sh': '#!/sh.js\nfor x in 1 2 3; do\necho $x | cat\ndone'
                }
            },
            permissions: execPerms('/scripts/loop-pipe.sh')
        });
        const output = [];
        shell.on('stdOut', l => output.push(l));
        await shell.onCommand('/scripts/loop-pipe.sh', false);
        expect(output[0]).toBe('1');
        expect(output[1]).toBe('2');
        expect(output[2]).toBe('3');
    });
});

describe('multiline quotes and line continuations in scripts', () => {
    it('joins lines with unclosed double quotes into a single logical line', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'multiline-dq.sh': '#!/sh.js\necho "hello\nworld"'
                }
            },
            permissions: execPerms('/scripts/multiline-dq.sh')
        });
        const { output } = await run(shell, '/scripts/multiline-dq.sh');
        expect(output).toEqual(['hello', 'world']);
    });

    it('joins lines with unclosed single quotes into a single logical line', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'multiline-sq.sh': '#!/sh.js\necho \'first\nsecond\''
                }
            },
            permissions: execPerms('/scripts/multiline-sq.sh')
        });
        const { output } = await run(shell, '/scripts/multiline-sq.sh');
        expect(output).toEqual(['first', 'second']);
    });

    it('joins lines with trailing line continuation backslash', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'continuation.sh': '#!/sh.js\necho \\\n  hello \\\n  world'
                }
            },
            permissions: execPerms('/scripts/continuation.sh')
        });
        const { output } = await run(shell, '/scripts/continuation.sh');
        expect(output).toEqual(['hello world']);
    });

    it('supports line continuation in if conditions', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'if-cont.sh': '#!/sh.js\nif [ 1 = 1 ] \\\n   && [ 2 = 2 ]; then\necho matched\nfi'
                }
            },
            permissions: execPerms('/scripts/if-cont.sh')
        });
        const { output } = await run(shell, '/scripts/if-cont.sh');
        expect(output).toEqual(['matched']);
    });

    it('supports negation operator in if condition: if ! command; then', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'if-not.sh': '#!/sh.js\nif ! which non_existent_binary; then\necho "not found handled"\nfi'
                }
            },
            permissions: execPerms('/scripts/if-not.sh')
        });
        const { output } = await run(shell, '/scripts/if-not.sh');
        expect(output).toEqual(['not found handled']);
    });

    it('does not execute if block when condition with ! succeeds: if ! true; then', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'if-not-true.sh': '#!/sh.js\nif ! true; then\necho unexpected\nelse\necho expected\nfi'
                }
            },
            permissions: execPerms('/scripts/if-not-true.sh')
        });
        const { output } = await run(shell, '/scripts/if-not-true.sh');
        expect(output).toEqual(['expected']);
    });
});

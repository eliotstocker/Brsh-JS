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

    it('expands $@ in for loops and matches pipe-separated alternatives in case clauses', async () => {
        const shell = await createShell({
            filesystem: {
                scripts: {
                    'args-case.sh': [
                        '#!/bin/sh',
                        'for ARG in $@',
                        'do',
                        '    case "$ARG" in',
                        '        --help|-h)',
                        '            echo "matched-help"',
                        '            ;;',
                        '        --phase2|-2)',
                        '            echo "matched-2"',
                        '            ;;',
                        '        *)',
                        '            echo "other:$ARG"',
                        '            ;;',
                        '    esac',
                        'done'
                    ].join('\n')
                }
            },
            permissions: execPerms('/scripts/args-case.sh')
        });
        const res = await run(shell, '/scripts/args-case.sh -2 --help custom');
        expect(res.exitCode).toBe(0);
        expect(res.output).toEqual(['matched-2', 'matched-help', 'other:custom']);
    });

    it('splits accumulated $EXTRA_ARGS and preserves distinct "$@" arguments in wrapper scripts', async () => {
        const received = [];
        class TargetApp extends Command {
            static get name() { return 'target-app'; }
            run() {
                received.push([...this.arguments]);
                return Promise.resolve();
            }
        }

        const shell = await createShell({
            filesystem: {
                bin: {
                    'launcher.sh': [
                        '#!/bin/sh',
                        'EXTRA_ARGS=""',
                        'for ARG in $@',
                        'do',
                        '    case "$ARG" in',
                        '        --blocks|--block|-b)',
                        '            EXTRA_ARGS="$EXTRA_ARGS -blocks"',
                        '            ;;',
                        '        *)',
                        '            EXTRA_ARGS="$EXTRA_ARGS $ARG"',
                        '            ;;',
                        '    esac',
                        'done',
                        'target-app -iwad "/game/freedoom1.wad" -nosound $EXTRA_ARGS'
                    ].join('\n'),
                    'passthrough.sh': '#!/bin/sh\ntarget-app "$@"\n'
                }
            },
            permissions: execPerms('/bin/launcher.sh', '/bin/passthrough.sh')
        });
        shell.context.setCommand(TargetApp);

        await run(shell, 'launcher.sh --blocks -scaling 2');
        await run(shell, 'passthrough.sh "first with spaces" --blocks');
        await run(shell, 'passthrough.sh');

        expect(received).toEqual([
            ['-iwad', '/game/freedoom1.wad', '-nosound', '-blocks', '-scaling', '2'],
            ['first with spaces', '--blocks'],
            []
        ]);
    });
});


describe('parameter expansion and literal dollars inside scripts', () => {
    let shell;
    const scripts = {
        'for-default.sh': '#!/sh.js\nfor i in ${LIST:-a b c}; do\necho $i\ndone',
        'case-default.sh': '#!/sh.js\ncase ${MODE:-fast} in\nfast) echo quick;;\nslow) echo steady;;\nesac',
        'assign.sh': '#!/sh.js\nNAME=${NAME:-guest}\necho hello $NAME',
        'nested.sh': '#!/sh.js\nOUT="${NOPE:-$(echo "a b")}"\necho "$OUT"',
        'sed-dollar.sh': '#!/sh.js\ncat /data/f.txt | sed -n \'$p\'',
        'tail-pipe.sh': '#!/sh.js\ncat /data/f.txt | tail -n 2',
        'length.sh': '#!/sh.js\nW=hello\necho ${#W}',
        'single-quote.sh': '#!/sh.js\nA=1\necho \'$A\''
    };

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                scripts,
                data: {'f.txt': 'one\ntwo\nthree\n'}
            },
            permissions: execPerms(...Object.keys(scripts).map(n => `/scripts/${n}`))
        });
    });

    const out = async path => (await run(shell, path)).output;

    it('for list uses a default', async () => {
        expect(await out('/scripts/for-default.sh')).toEqual(['a', 'b', 'c']);
    });

    it('for list uses the variable over the default when set', async () => {
        await shell.onCommand('export LIST="x y"');
        expect(await out('/scripts/for-default.sh')).toEqual(['x', 'y']);
    });

    it('case word uses a default', async () => {
        expect(await out('/scripts/case-default.sh')).toEqual(['quick']);
        await shell.onCommand('export MODE=slow');
        expect(await out('/scripts/case-default.sh')).toEqual(['steady']);
    });

    it('assigns from a default', async () => {
        expect(await out('/scripts/assign.sh')).toEqual(['hello guest']);
        await shell.onCommand('export NAME=eliot');
        expect(await out('/scripts/assign.sh')).toEqual(['hello eliot']);
    });

    it('handles a quoted command substitution default', async () => {
        expect(await out('/scripts/nested.sh')).toEqual(['a b']);
    });

    it('gives ${#var} length', async () => {
        expect(await out('/scripts/length.sh')).toEqual(['5']);
    });

    it('keeps $ literal in single quotes for sed', async () => {
        expect(await out('/scripts/sed-dollar.sh')).toEqual(['three']);
    });

    it('keeps $ literal in single quotes for echo', async () => {
        expect(await out('/scripts/single-quote.sh')).toEqual(['$A']);
    });

    it('pipes into tail', async () => {
        expect(await out('/scripts/tail-pipe.sh')).toEqual(['two', 'three']);
    });
});

describe('$@ and $*', () => {
    let shell;
    const scripts = {
        'args.sh': '#!/sh.js\necho "n=$#"\nfor a in "$@"; do\necho "[$a]"\ndone\necho "star=$*"\necho "at=$@"',
        'fn.sh': '#!/sh.js\nf() {\nfor a in "$@"; do\necho "[$a]"\ndone\necho "star=$*"\n}\nf a "b c" d',
        'none.sh': '#!/sh.js\nfor a in "$@"; do\necho "[$a]"\ndone\necho "n=$#"'
    };

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {scripts},
            permissions: execPerms(...Object.keys(scripts).map(n => `/scripts/${n}`))
        });
    });

    const out = async cmd => (await run(shell, cmd)).output;

    it('"$@" keeps each argument as a separate word in a script', async () => {
        expect(await out('/scripts/args.sh p "q r" s')).toEqual(['n=3', '[p]', '[q r]', '[s]', 'star=p q r s', 'at=p q r s']);
    });

    it('"$@" keeps each argument as a separate word in a function', async () => {
        expect(await out('/scripts/fn.sh')).toEqual(['[a]', '[b c]', '[d]', 'star=a b c d']);
    });

    it('"$@" expands to nothing with no arguments', async () => {
        expect(await out('/scripts/none.sh')).toEqual(['n=0']);
    });
});

describe('local, shift, unset and : in scripts', () => {
    let shell;
    const scripts = {
        'local.sh': '#!/sh.js\nX=outer\nf() {\nlocal X=inner\necho "in:$X"\n}\nf\necho "out:$X"',
        'local-new.sh': '#!/sh.js\nf() {\nlocal NEWVAR=1\necho "in:$NEWVAR"\n}\nf\necho "out:[$NEWVAR]"',
        'local-unset.sh': '#!/sh.js\nX=outer\nf() {\nlocal X\necho "in:[$X]"\n}\nf\necho "out:$X"',
        'local-multi.sh': '#!/sh.js\nA=a\nB=b\nf() {\nlocal A=1 B=2 C\necho "$A$B[$C]"\n}\nf\necho "$A$B"',
        'local-twice.sh': '#!/sh.js\nX=orig\nf() {\nlocal X=1\nlocal X=2\necho $X\n}\nf\necho $X',
        'local-nested.sh': '#!/sh.js\nX=top\ng() {\necho "g:$X"\nX=g-changed\n}\nf() {\nlocal X=f-local\ng\necho "f:$X"\n}\nf\necho "top:$X"',
        'local-global-write.sh': '#!/sh.js\nf() {\nG=set-in-f\n}\nf\necho $G',
        'local-recursion.sh': '#!/sh.js\nf() {\nlocal N=$1\nif [ $N -gt 0 ]; then\nf $((N - 1))\nfi\necho $N\n}\nf 2',
        'local-top.sh': '#!/sh.js\nlocal X=1\necho after',
        'local-bad.sh': '#!/sh.js\nf() {\nlocal 1bad=x\n}\nf',
        'shift.sh': '#!/sh.js\necho "$# $1 $2 $3"\nshift\necho "$# $1 $2 $3"\nshift 2\necho "$# [$1]"',
        'shift-all.sh': '#!/sh.js\nshift 3\necho "$# [$@]"',
        'shift-range.sh': '#!/sh.js\nshift 5\necho unreachable',
        'shift-fn.sh': '#!/sh.js\nf() {\nshift\necho "f:$1 $#"\n}\nf a b c\necho "top:$1 $#"',
        'shift-loop.sh': '#!/sh.js\nwhile [ $# -gt 0 ]; do\necho "arg:$1"\nshift\ndone',
        'unset.sh': '#!/sh.js\nA=1\nB=2\nunset A\necho "[$A][$B]"\nunset B NOPE\necho "[$B]"',
        'unset-default.sh': '#!/sh.js\nA=1\nunset A\necho ${A:-gone}',
        'unset-bad.sh': '#!/sh.js\nunset 1bad\necho rc=$?',
        'colon.sh': '#!/sh.js\n: ignored args\necho "rc=$?"',
        'colon-default.sh': '#!/sh.js\n: ${CFG:=fallback}\necho $CFG',
        'colon-while.sh': '#!/sh.js\nn=0\nwhile :; do\nn=$((n + 1))\nif [ $n -ge 3 ]; then\nbreak\nfi\ndone\necho $n'
    };

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {scripts},
            permissions: execPerms(...Object.keys(scripts).map(n => `/scripts/${n}`))
        });
    });

    const out = async cmd => (await run(shell, cmd)).output;

    it('local shadows a variable and restores it on return', async () => {
        expect(await out('/scripts/local.sh')).toEqual(['in:inner', 'out:outer']);
    });

    it('a local that did not exist before is gone after return', async () => {
        expect(await out('/scripts/local-new.sh')).toEqual(['in:1', 'out:[]']);
    });

    it('local without a value starts unset and restores the old value', async () => {
        expect(await out('/scripts/local-unset.sh')).toEqual(['in:[]', 'out:outer']);
    });

    it('local takes several names at once', async () => {
        expect(await out('/scripts/local-multi.sh')).toEqual(['12[]', 'ab']);
    });

    it('declaring the same local twice still restores the original', async () => {
        expect(await out('/scripts/local-twice.sh')).toEqual(['2', 'orig']);
    });

    it('callees see and modify the caller\'s local (dynamic scope)', async () => {
        expect(await out('/scripts/local-nested.sh')).toEqual(['g:f-local', 'f:g-changed', 'top:top']);
    });

    it('plain assignments in a function stay global', async () => {
        expect(await out('/scripts/local-global-write.sh')).toEqual(['set-in-f']);
    });

    it('each recursive call has its own local', async () => {
        expect(await out('/scripts/local-recursion.sh')).toEqual(['0', '1', '2']);
    });

    it('local outside a function is an error', async () => {
        const res = await run(shell, '/scripts/local-top.sh');
        expect(res.errors.join(' ')).toMatch(/can only be used in a function/);
        expect(res.output).toContain('after');
    });

    it('local rejects an invalid name', async () => {
        const res = await run(shell, '/scripts/local-bad.sh');
        expect(res.errors.join(' ')).toMatch(/not a valid identifier/);
    });

    it('shift drops positional parameters and updates $#', async () => {
        expect(await out('/scripts/shift.sh a b c d')).toEqual(['4 a b c', '3 b c d', '1 [d]']);
    });

    it('shift N past all parameters leaves none', async () => {
        expect(await out('/scripts/shift-all.sh a b c')).toEqual(['0 []']);
    });

    it('shift with a count out of range errors and changes nothing', async () => {
        const res = await run(shell, '/scripts/shift-range.sh a b');
        expect(res.errors.join(' ')).toMatch(/shift count out of range/);
    });

    it('shift inside a function only affects the function\'s parameters', async () => {
        expect(await out('/scripts/shift-fn.sh x y')).toEqual(['f:b 2', 'top:x 2']);
    });

    it('shift drives an argument loop', async () => {
        expect(await out('/scripts/shift-loop.sh a b c')).toEqual(['arg:a', 'arg:b', 'arg:c']);
    });

    it('unset removes variables and ignores ones that do not exist', async () => {
        expect(await out('/scripts/unset.sh')).toEqual(['[][2]', '[]']);
    });

    it('an unset variable takes the default again', async () => {
        expect(await out('/scripts/unset-default.sh')).toEqual(['gone']);
    });

    it('unset rejects an invalid name', async () => {
        const res = await run(shell, '/scripts/unset-bad.sh');
        expect(res.errors.join(' ')).toMatch(/not a valid identifier/);
        expect(res.output).toEqual(['rc=1']);
    });

    it(': does nothing and exits 0', async () => {
        const res = await run(shell, '/scripts/colon.sh');
        expect(res.output).toEqual(['rc=0']);
        expect(res.errors).toEqual([]);
    });

    it(': ${VAR:=default} assigns the default', async () => {
        expect(await out('/scripts/colon-default.sh')).toEqual(['fallback']);
    });

    it('while : loops until break', async () => {
        expect(await out('/scripts/colon-while.sh')).toEqual(['3']);
    });
});

describe('one-line control flow', () => {
    let shell;
    const scripts = {
        'chain.sh': '#!/sh.js\nif [ "$1" = a ]; then echo A; elif [ "$1" = b ]; then echo B; elif [ "$1" = c ]; then echo C; else echo other; fi\necho done',
        'if-else.sh': '#!/sh.js\nif [ "$1" = yes ]; then echo y; else echo n; fi',
        'if-only.sh': '#!/sh.js\nif [ "$1" = yes ]; then echo y; fi\necho after',
        'mixed.sh': '#!/sh.js\nif [ "$1" = a ]; then\necho A\nelif [ "$1" = b ]; then echo B\nelse echo other\nfi',
        'for.sh': '#!/sh.js\nfor i in 1 2 3; do echo $i; done\necho end',
        'for-if.sh': '#!/sh.js\nfor i in 1 2 3; do if [ $i = 2 ]; then echo two; elif [ $i = 3 ]; then echo three; else echo no; fi; done',
        'while.sh': '#!/sh.js\ni=0\nwhile [ $i -lt 3 ]; do i=$((i + 1)); echo $i; done\necho end',
        'nested.sh': '#!/sh.js\nif true; then if [ "$1" = x ]; then echo inner-x; else echo inner-other; fi; fi',
        'trailing.sh': '#!/sh.js\nif true; then echo hi; fi; echo after',
        'quoted.sh': '#!/sh.js\nif true; then echo "a; b; fi"; fi',
        'subst.sh': '#!/sh.js\nif true; then echo $(echo x; echo y); fi',
        'comment.sh': '#!/sh.js\nif true; then echo hi; fi # trailing comment',
        'fn.sh': '#!/sh.js\nf() {\nif [ "$1" = a ]; then echo A; elif [ "$1" = b ]; then echo B; else echo C; fi\n}\nf a\nf b\nf z',
        'case.sh': '#!/sh.js\ncase "$1" in\na) echo one; echo uno;;\n*) echo many;;\nesac\nif true; then echo after; fi',
        'multi-cmd.sh': '#!/sh.js\nif true; then echo one; echo two; echo three; fi',
        'cond-and.sh': '#!/sh.js\nif [ "$1" = a ] && [ "$2" = b ]; then echo both; else echo not; fi',
        'cmd-first.sh': '#!/sh.js\necho before; if true; then echo inside; fi'
    };

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {scripts},
            permissions: execPerms(...Object.keys(scripts).map(n => `/scripts/${n}`))
        });
    });

    const out = async cmd => {
        const res = await run(shell, cmd);
        expect(res.errors).toEqual([]);
        return res.output;
    };

    it('runs the matching branch of an if/elif/else chain on one line', async () => {
        expect(await out('/scripts/chain.sh a')).toEqual(['A', 'done']);
        expect(await out('/scripts/chain.sh b')).toEqual(['B', 'done']);
        expect(await out('/scripts/chain.sh c')).toEqual(['C', 'done']);
        expect(await out('/scripts/chain.sh zzz')).toEqual(['other', 'done']);
    });

    it('runs a one-line if/else', async () => {
        expect(await out('/scripts/if-else.sh yes')).toEqual(['y']);
        expect(await out('/scripts/if-else.sh no')).toEqual(['n']);
    });

    it('runs a one-line if with no else, and carries on afterwards', async () => {
        expect(await out('/scripts/if-only.sh yes')).toEqual(['y', 'after']);
        expect(await out('/scripts/if-only.sh no')).toEqual(['after']);
    });

    it('handles then/else commands on the same line as the keyword in a multi-line if', async () => {
        expect(await out('/scripts/mixed.sh a')).toEqual(['A']);
        expect(await out('/scripts/mixed.sh b')).toEqual(['B']);
        expect(await out('/scripts/mixed.sh z')).toEqual(['other']);
    });

    it('runs a one-line for loop', async () => {
        expect(await out('/scripts/for.sh')).toEqual(['1', '2', '3', 'end']);
    });

    it('runs an if/elif/else chain inside a one-line for loop', async () => {
        expect(await out('/scripts/for-if.sh')).toEqual(['no', 'two', 'three']);
    });

    it('runs a one-line while loop', async () => {
        expect(await out('/scripts/while.sh')).toEqual(['1', '2', '3', 'end']);
    });

    it('handles nested one-line ifs', async () => {
        expect(await out('/scripts/nested.sh x')).toEqual(['inner-x']);
        expect(await out('/scripts/nested.sh y')).toEqual(['inner-other']);
    });

    it('runs commands after fi on the same line', async () => {
        expect(await out('/scripts/trailing.sh')).toEqual(['hi', 'after']);
        expect(await out('/scripts/cmd-first.sh')).toEqual(['before', 'inside']);
    });

    it('does not split on ; inside quotes', async () => {
        expect(await out('/scripts/quoted.sh')).toEqual(['a; b; fi']);
    });

    it('does not split on ; inside $( )', async () => {
        expect(await out('/scripts/subst.sh')).toEqual(['x y']);
    });

    it('ignores a trailing comment', async () => {
        expect(await out('/scripts/comment.sh')).toEqual(['hi']);
    });

    it('works inside a function body', async () => {
        expect(await out('/scripts/fn.sh')).toEqual(['A', 'B', 'C']);
    });

    it('runs several commands in one then branch', async () => {
        expect(await out('/scripts/multi-cmd.sh')).toEqual(['one', 'two', 'three']);
    });

    it('supports && in the condition', async () => {
        expect(await out('/scripts/cond-and.sh a b')).toEqual(['both']);
        expect(await out('/scripts/cond-and.sh a c')).toEqual(['not']);
    });

    it('leaves ; inside case clauses alone', async () => {
        expect(await out('/scripts/case.sh a')).toEqual(['one', 'uno', 'after']);
        expect(await out('/scripts/case.sh q')).toEqual(['many', 'after']);
    });
});

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

describe('backslash quote escaping', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('parses echo "hello \\"world\\"" to [\'echo\', \'hello "world"\']', async () => {
        const cmd = 'echo "hello \\"world\\""';
        const parts = Shell._splitCommand(cmd).map(p => p.value);
        expect(parts).toEqual(['echo', 'hello "world"']);

        const { output, errors, exitCode } = await run(shell, cmd);
        expect(errors).toHaveLength(0);
        expect(exitCode).toBe(0);
        expect(output).toEqual(['hello "world"']);
    });

    it('parses echo "Eliot\'s CV with \\"nested quotes\\"" cleanly without throwing quote expression not closed', async () => {
        const cmd = 'echo "Eliot\'s CV with \\"nested quotes\\""';
        const parts = Shell._splitCommand(cmd).map(p => p.value);
        expect(parts).toEqual(['echo', 'Eliot\'s CV with "nested quotes"']);

        const { output, errors, exitCode } = await run(shell, cmd);
        expect(errors).toHaveLength(0);
        expect(exitCode).toBe(0);
        expect(output).toEqual(['Eliot\'s CV with "nested quotes"']);
    });

    it('parses echo \'Eliot\'\\\'\'s experience\' correctly into [\'echo\', "Eliot\'s experience"]', async () => {
        const cmd = "echo 'Eliot'\\''s experience'";
        const parts = Shell._splitCommand(cmd).map(p => p.value);
        expect(parts).toEqual(['echo', "Eliot's experience"]);

        const { output, errors, exitCode } = await run(shell, cmd);
        expect(errors).toHaveLength(0);
        expect(exitCode).toBe(0);
        expect(output).toEqual(["Eliot's experience"]);
    });

    it('parses echo \\"unquoted\\" to [\'echo\', \'"unquoted"\']', async () => {
        const cmd = 'echo \\"unquoted\\"';
        const parts = Shell._splitCommand(cmd).map(p => p.value);
        expect(parts).toEqual(['echo', '"unquoted"']);

        const { output, errors, exitCode } = await run(shell, cmd);
        expect(errors).toHaveLength(0);
        expect(exitCode).toBe(0);
        expect(output).toEqual(['"unquoted"']);
    });
});

describe('output redirection', () => {
    it('writes command stdout to a file with >', async () => {
        const shell = await createShell({ filesystem: { home: {} } });
        await run(shell, 'echo hello > /home/out.txt');
        expect(shell.context.fs.getFileByPath('/home/out.txt')).toBe('hello');
    });

    it('overwrites an existing file with >', async () => {
        const shell = await createShell({ filesystem: { home: { 'out.txt': 'old' } } });
        await run(shell, 'echo new > /home/out.txt');
        expect(shell.context.fs.getFileByPath('/home/out.txt')).toBe('new');
    });

    it('appends to an existing file with >>', async () => {
        const shell = await createShell({ filesystem: { home: { 'out.txt': 'first' } } });
        await run(shell, 'echo second >> /home/out.txt');
        expect(shell.context.fs.getFileByPath('/home/out.txt')).toBe('first\nsecond');
    });

    it('errors when target file is not writable', async () => {
        const shell = await createShell({
            filesystem: { home: { 'readonly.txt': 'original' } },
            permissions: { '/home/readonly.txt': 0o444 }
        });
        const { errors, exitCode } = await run(shell, 'echo foo > /home/readonly.txt');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/permission denied/i);
        expect(shell.context.fs.getFileByPath('/home/readonly.txt')).toBe('original');
    });

    it('errors when target directory is not writable', async () => {
        const shell = await createShell({
            filesystem: { protected: {} },
            permissions: { '/protected': 0o555 }
        });
        const { errors, exitCode } = await run(shell, 'echo foo > /protected/newfile.txt');
        expect(exitCode).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/permission denied/i);
        expect(shell.context.fs.getFileByPath('/protected/newfile.txt')).toBeNull();
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

describe('Pipes', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('pipes stdout of first command to stdin of second', async () => {
        const { output } = await run(shell, 'echo hello world | cat');
        expect(output.join('\n')).toContain('hello world');
    });

    it('filters output through grep via pipe', async () => {
        const { output } = await run(shell, 'echo -e "foo\nbar\nbaz" | grep bar');
        expect(output.join('\n')).toContain('bar');
        expect(output.join('\n')).not.toContain('foo');
    });

    it('supports chaining three commands', async () => {
        const { output } = await run(shell, 'echo -e "alpha\nbeta\nalpha" | grep alpha | cat');
        const joined = output.join('\n');
        expect(joined).toContain('alpha');
        expect(joined).not.toContain('beta');
    });

    it('sets exit code from the last command in the pipe', async () => {
        const { exitCode } = await run(shell, 'echo hello | grep nomatch');
        expect(exitCode).toBe(1);
    });

    it('does not confuse || with |', async () => {
        await shell.onCommand('export X=0');
        const { output } = await run(shell, 'false || echo fallback');
        expect(output.join('\n')).toContain('fallback');
    });
});

describe('. (dot) command', () => {
    it('is an alias for source and executes a script file', async () => {
        const shell = await createShell({
            filesystem: {
                bin: {},
                home: {
                    'greet.sh': '#!/bin/sh\nexport GREETED=yes\n'
                }
            }
        });
        await shell.onCommand('cd /home');
        await shell.onCommand('. /home/greet.sh');
        expect(shell.context.getVar('GREETED')).toBe('yes');
    });
});

describe('MOTD, profile, and initial command startup chain', () => {
    function bootShell(options) {
        return new Promise((resolve) => {
            const output = [];
            const errors = [];
            const shell = new Shell({ filesystem: {}, ...options });
            shell.on('stdOut', (line) => output.push(line));
            shell.on('stdErr', (line) => errors.push(line));
            shell.once('status', (status) => {
                resolve({ shell, output, errors, status });
            });
        });
    }

    it('prints static /etc/motd before sourcing profile', async () => {
        const { output, shell } = await bootShell({
            profile: '/home/.profile',
            cwd: '/home',
            filesystem: {
                etc: {
                    motd: 'Welcome to the system!\nSecond MOTD line\n'
                },
                home: {
                    '.profile': '#!/bin/brsh\nexport PROFILE_LOADED=1\necho "profile ran"'
                }
            }
        });

        expect(output).toEqual([
            'Welcome to the system!',
            'Second MOTD line',
            'profile ran'
        ]);
        expect(shell.context.getVar('PROFILE_LOADED')).toBe('1');
    });

    it('runs executable scripts in /etc/update-motd.d in lexical order before /etc/motd and profile', async () => {
        const { output } = await bootShell({
            profile: '/home/.profile',
            cwd: '/home',
            filesystem: {
                etc: {
                    'update-motd.d': {
                        '20-second': '#!/bin/brsh\necho "motd-20"',
                        '10-first': '#!/bin/brsh\necho "motd-10"',
                        '30-disabled': '#!/bin/brsh\necho "motd-disabled"'
                    },
                    motd: 'static-motd'
                },
                home: {
                    '.profile': '#!/bin/brsh\necho "profile-last"'
                }
            },
            permissions: {
                '/etc/update-motd.d/10-first': 0o755,
                '/etc/update-motd.d/20-second': 0o755,
                '/etc/update-motd.d/30-disabled': 0o644
            }
        });

        expect(output).toEqual([
            'motd-10',
            'motd-20',
            'static-motd',
            'profile-last'
        ]);
    });

    it('supports a script file at /etc/motd or custom motd option', async () => {
        const { output } = await bootShell({
            motd: '/home/.motd',
            cwd: '/home',
            filesystem: {
                home: {
                    '.motd': '#!/bin/brsh\necho "dynamic motd banner"'
                }
            }
        });

        expect(output).toEqual(['dynamic motd banner']);
    });

    it('suppresses MOTD when .hushlogin exists in cwd', async () => {
        const { output, shell } = await bootShell({
            profile: '/home/.profile',
            cwd: '/home',
            filesystem: {
                etc: {
                    motd: 'Should not be shown'
                },
                home: {
                    '.hushlogin': '',
                    '.profile': '#!/bin/brsh\nexport HUSHED=yes'
                }
            }
        });

        expect(output).toEqual([]);
        expect(shell.context.getVar('HUSHED')).toBe('yes');
    });

    it('suppresses MOTD when motd: false is set', async () => {
        const { output } = await bootShell({
            motd: false,
            filesystem: {
                etc: {
                    motd: 'Should not be shown'
                }
            }
        });

        expect(output).toEqual([]);
    });

    it('sources /etc/profile before user profile', async () => {
        const { output } = await bootShell({
            profile: '/home/.profile',
            cwd: '/home',
            filesystem: {
                etc: {
                    profile: '#!/bin/brsh\nexport ORDER="etc"'
                },
                home: {
                    '.profile': '#!/bin/brsh\nexport ORDER="${ORDER}->user"\necho $ORDER'
                }
            }
        });

        expect(output).toEqual(['etc->user']);
    });

    it('skips MOTD when an initial command is provided, but still sources profile so aliases work', async () => {
        const { output, shell } = await bootShell({
            profile: '/home/.profile',
            command: 'cv',
            cwd: '/home',
            filesystem: {
                etc: {
                    'update-motd.d': {
                        '00-info': '#!/bin/brsh\necho "MOTD INFO BANNER"'
                    },
                    motd: 'STATIC MOTD BANNER'
                },
                home: {
                    '.profile': '#!/bin/brsh\nalias cv="echo rendering-cv"'
                }
            },
            permissions: {
                '/etc/update-motd.d/00-info': 0o755
            }
        });

        expect(output).toEqual(['rendering-cv']);
        expect(output).not.toContain('MOTD INFO BANNER');
        expect(output).not.toContain('STATIC MOTD BANNER');
        expect(shell.context.getVar('-')).toBe('i');
    });

    it('skips MOTD when suppressMotd() is called synchronously before init (like Terminal.onCommand)', async () => {
        const output = [];
        const shell = new Shell({
            profile: '/home/.profile',
            cwd: '/home',
            filesystem: {
                etc: {
                    motd: 'STATIC MOTD BANNER'
                },
                home: {
                    '.profile': '#!/bin/brsh\nalias cv="echo rendering-cv"'
                }
            }
        });
        shell.suppressMotd();
        shell.on('stdOut', (line) => output.push(line));

        await new Promise((resolve) => shell.once('status', resolve));
        await shell.onCommand('cv');

        expect(output).toEqual(['rendering-cv']);
    });

    it('sets c in $- during profile execution when an initial command is run', async () => {
        const { output } = await bootShell({
            profile: '/home/.profile',
            command: 'echo "ran command"',
            cwd: '/home',
            filesystem: {
                home: {
                    '.profile': '#!/bin/brsh\ncase "$-" in\n  *c*) echo "non-motd mode" ;;\n  *) echo "motd mode" ;;\nesac'
                }
            }
        });

        expect(output).toEqual(['non-motd mode', 'ran command']);
    });

    it('does not re-run MOTD in subshells (pipes, command substitution, scripts)', async () => {
        const { shell, output } = await bootShell({
            cwd: '/home',
            filesystem: {
                etc: {
                    motd: 'WELCOME_MOTD'
                },
                home: {
                    'script.sh': '#!/bin/brsh\necho $(echo sub) | cat'
                }
            },
            permissions: {
                '/home/script.sh': 0o755
            }
        });

        expect(output).toEqual(['WELCOME_MOTD']);

        const res = await run(shell, '/home/script.sh');
        expect(res.output).toEqual(['sub']);
    });
});

describe('negation operator (!)', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('inverts successful exit code 0 to 1 for ! true', async () => {
        const { exitCode } = await run(shell, '! true');
        expect(exitCode).toBe(1);
    });

    it('inverts failure exit code to 0 for ! false', async () => {
        const { exitCode } = await run(shell, '! false');
        expect(exitCode).toBe(0);
    });

    it('inverts non-zero exit code of missing command for ! which wllama', async () => {
        const { exitCode } = await run(shell, '! which wllama');
        expect(exitCode).toBe(0);
    });

    it('inverts exit code in conditional chains with &&', async () => {
        const { output, exitCode } = await run(shell, '! false && echo "negated success"');
        expect(output).toContain('negated success');
        expect(exitCode).toBe(0);
    });

    it('inverts exit code in conditional chains with ||', async () => {
        const { output, exitCode } = await run(shell, '! true || echo "fallback"');
        expect(output).toContain('fallback');
        expect(exitCode).toBe(0);
    });

    it('inverts exit code of a pipeline with leading !', async () => {
        const { exitCode } = await run(shell, '! true | false');
        expect(exitCode).toBe(0);
    });

    it('inverts exit code of a pipeline stage', async () => {
        const { exitCode } = await run(shell, 'false | ! true');
        expect(exitCode).toBe(1);
    });
});

describe('stream redirection syntax', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                home: {}
            }
        });
    });

    it('redirects stderr to stdout with 2>&1', async () => {
        const { output, errors } = await run(shell, 'cat /non_existent 2>&1');
        expect(errors).toHaveLength(0);
        expect(output.length).toBeGreaterThan(0);
        expect(output[0]).toContain('No such file or directory');
    });

    it('pipes stderr into next stage when using 2>&1 |', async () => {
        const { output } = await run(shell, 'cat /non_existent 2>&1 | cat');
        expect(output.length).toBeGreaterThan(0);
        expect(output[0]).toContain('No such file or directory');
    });

    it('discards stderr when redirected to /dev/null with 2> /dev/null', async () => {
        const { output, errors, exitCode } = await run(shell, 'cat /non_existent 2> /dev/null');
        expect(errors).toHaveLength(0);
        expect(output).toHaveLength(0);
        expect(exitCode).not.toBe(0);
    });

    it('strips 2>&1 from positional arguments (argv) so command does not receive it as an argument', async () => {
        // which rejects with "which requires a single argument" if 2>&1 is not stripped
        const { output, errors } = await run(shell, 'which non_existent 2>&1');
        expect(output.join(' ')).not.toContain('which requires a single argument');
        expect(errors.join(' ')).not.toContain('which requires a single argument');
    });

    it('redirects stderr to a file with 2>', async () => {
        await run(shell, 'cat /non_existent 2> /home/err.txt');
        const content = shell.context.fs.getFileByPath('/home/err.txt');
        expect(content).toContain('No such file or directory');
    });

    it('appends stderr to a file with 2>>', async () => {
        shell.context.fs.setFileByPath('/home/err.txt', 'existing', true);
        await run(shell, 'cat /non_existent 2>> /home/err.txt');
        const content = shell.context.fs.getFileByPath('/home/err.txt');
        expect(content).toContain('existing\n');
        expect(content).toContain('No such file or directory');
    });

    it('redirects stdout with 1> and 1>>', async () => {
        await run(shell, 'echo first 1> /home/out.txt');
        await run(shell, 'echo second 1>> /home/out.txt');
        expect(shell.context.fs.getFileByPath('/home/out.txt')).toBe('first\nsecond');
    });

    it('redirects both stdout and stderr to a file with &>', async () => {
        await run(shell, 'echo test &> /home/combined.txt');
        expect(shell.context.fs.getFileByPath('/home/combined.txt')).toBe('test');
    });

    it('redirects both stdout and stderr to a file with > file 2>&1', async () => {
        await run(shell, 'echo msg > /home/both.txt 2>&1');
        expect(shell.context.fs.getFileByPath('/home/both.txt')).toBe('msg');
    });

    it('preserves quoted redirection tokens as literal arguments', async () => {
        const { output } = await run(shell, 'echo "2>&1"');
        expect(output).toEqual(['2>&1']);
    });
});

describe('unquoted expansion word splitting', () => {
    let shell;
    let capturedArgs;

    beforeEach(async () => {
        capturedArgs = [];
        class ArgCaptureCmd extends Shell.Command {
            static get name() { return 'capture'; }
            run() {
                capturedArgs.push([...this.arguments]);
                return Promise.resolve();
            }
        }
        shell = await createShell();
        shell.context.setCommand(ArgCaptureCmd);
    });

    it('splits unquoted variable expansions on whitespace and strips leading/trailing spaces', async () => {
        await run(shell, 'EXTRA_ARGS=""');
        await run(shell, 'EXTRA_ARGS="$EXTRA_ARGS -blocks"');
        await run(shell, 'capture -iwad "/path with spaces/freedoom1.wad" -nosound $EXTRA_ARGS');
        expect(capturedArgs).toEqual([
            ['-iwad', '/path with spaces/freedoom1.wad', '-nosound', '-blocks']
        ]);
    });

    it('splits multiple flags accumulated in an unquoted variable into separate argv tokens', async () => {
        await run(shell, 'EXTRA_ARGS=" -blocks -scaling 2 "');
        await run(shell, 'capture $EXTRA_ARGS');
        expect(capturedArgs).toEqual([['-blocks', '-scaling', '2']]);
    });

    it('omits empty unquoted variable expansions while preserving explicit empty quotes ""', async () => {
        await run(shell, 'EMPTY=""');
        await run(shell, 'capture a $EMPTY "" b');
        expect(capturedArgs).toEqual([['a', '', 'b']]);
    });

    it('preserves whitespace when variable expansion is double-quoted', async () => {
        await run(shell, 'EXTRA_ARGS=" -blocks -scaling 2"');
        await run(shell, 'capture "$EXTRA_ARGS"');
        expect(capturedArgs).toEqual([[' -blocks -scaling 2']]);
    });

    it('does not word-split bare variable assignments or export assignments', async () => {
        await run(shell, 'SRC="  hello   world  "');
        await run(shell, 'DEST=$SRC');
        expect(shell.context.getVar('DEST')).toBe('  hello   world  ');

        await run(shell, 'export EXPORTED=$(echo alpha beta)');
        expect(shell.context.getVar('EXPORTED')).toBe('alpha beta');
    });

    it('preserves backslash-escaped spaces on literal tokens without $ expansion', async () => {
        await run(shell, 'capture hello\\ world');
        expect(capturedArgs).toEqual([['hello world']]);
    });
});


describe('parameter expansion ${var:-default} family', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    const out = async cmd => (await run(shell, cmd)).output;

    it(':- uses the default when unset or empty', async () => {
        expect(await out('echo ${NOPE:-fallback}')).toEqual(['fallback']);
        await shell.onCommand('export SET=value');
        expect(await out('echo ${SET:-fallback}')).toEqual(['value']);
    });

    it('- without a colon behaves the same', async () => {
        expect(await out('echo ${NOPE-fallback}')).toEqual(['fallback']);
    });

    it(':= assigns the default', async () => {
        expect(await out('echo ${NEW:=assigned}')).toEqual(['assigned']);
        expect(shell.context.getVar('NEW')).toBe('assigned');
    });

    it(':+ uses the alternative only when set', async () => {
        expect(await out('echo ${NOPE:+alt}')).toEqual([]);
        await shell.onCommand('export SET=1');
        expect(await out('echo ${SET:+alt}')).toEqual(['alt']);
    });

    it(':? errors when unset and passes when set', async () => {
        const res = await run(shell, 'echo ${NOPE:?must be set}');
        expect(res.errors.join(' ')).toContain('NOPE: must be set');
        expect(res.exitCode).toBeGreaterThan(0);
        expect(res.output).toEqual([]);
        await shell.onCommand('export SET=1');
        expect(await out('echo ${SET:?must be set}')).toEqual(['1']);
    });

    it('${#var} gives the string length', async () => {
        await shell.onCommand('export WORD=hello');
        expect(await out('echo ${#WORD}')).toEqual(['5']);
    });

    it('the default can contain spaces and quotes when quoted', async () => {
        expect(await out('echo "${NOPE:-two words}"')).toEqual(['two words']);
        expect(await out('echo ${NOPE:-"two words"}')).toEqual(['two words']);
    });

    it('the default can reference another variable', async () => {
        await shell.onCommand('export OTHER=from-other');
        expect(await out('echo ${NOPE:-$OTHER}')).toEqual(['from-other']);
        expect(await out('echo ${NOPE:-${OTHER}}')).toEqual(['from-other']);
    });

    it('the default can be a command substitution containing quotes and parens', async () => {
        expect(await out('echo "${NOPE:-$(echo "a b")}"')).toEqual(['a b']);
        expect(await out('echo "${NOPE:-$(echo $((1 + 2)))}"')).toEqual(['3']);
    });

    it('a } inside a quoted command substitution does not end the expansion early', async () => {
        expect(await out('echo "${NOPE:-$(echo "x}y")}"')).toEqual(['x}y']);
    });

    it('is not re-expanded when the value contains a dollar', async () => {
        await shell.onCommand('export DOLLAR=\'$HOME\'');
        expect(await out('echo ${DOLLAR}')).toEqual(['$HOME']);
    });

    it('still expands plain $VAR and ${VAR}', async () => {
        await shell.onCommand('export A=1');
        expect(await out('echo $A${A}$A')).toEqual(['111']);
    });

    it('works inside assignments', async () => {
        await shell.onCommand('FINAL=${FINAL:-default}');
        expect(shell.context.getVar('FINAL')).toBe('default');
    });
});

describe('literal dollar signs', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    it('single quotes block expansion', async () => {
        await shell.onCommand('export A=1');
        const { output } = await run(shell, `echo '$A \${A:-x} $(echo hi)'`);
        expect(output).toEqual(['$A ${A:-x} $(echo hi)']);
    });

    it('a backslash blocks expansion outside and inside double quotes', async () => {
        await shell.onCommand('export A=1');
        expect((await run(shell, 'echo \\$A')).output).toEqual(['$A']);
        expect((await run(shell, 'echo "\\$A"')).output).toEqual(['$A']);
    });
});

describe('multi-line strings, arithmetic and substitution output', () => {
    let shell;
    beforeEach(async () => { shell = await createShell(); });

    const out = async cmd => (await run(shell, cmd)).output;

    it('keeps a multi-line double-quoted string as one argument', async () => {
        expect(await out('echo "line one\nline two"')).toEqual(['line one', 'line two']);
    });

    it('assigns a multi-line double-quoted string to a variable', async () => {
        await shell.onCommand('MSG="line one\nline two"');
        expect(shell.context.getVar('MSG')).toBe('line one\nline two');
    });

    it('expands a variable holding newlines inside quotes', async () => {
        await shell.onCommand('MSG="a\nb"');
        expect(await out('echo "$MSG"')).toEqual(['a', 'b']);
    });

    it('$((n + 1)) with spaces, assigned and quoted', async () => {
        await shell.onCommand('n=1');
        await shell.onCommand('n=$((n + 1))');
        expect(shell.context.getVar('n')).toBe('2');
        expect(await out('echo $((n + 1))')).toEqual(['3']);
        expect(await out('echo "$((n * 3))"')).toEqual(['6']);
    });

    it('arithmetic works as a default and inside a default', async () => {
        await shell.onCommand('n=4');
        expect(await out('echo ${NOPE:-$((n + 1))}')).toEqual(['5']);
    });

    it('does not split on ; inside $( )', async () => {
        await shell.onCommand('X=$(echo a; echo b)');
        expect(shell.context.getVar('X')).toBe('a\nb');
    });

    it('does not split on && or || or | inside $( )', async () => {
        expect(await out('echo "$(echo a && echo b)"')).toEqual(['a', 'b']);
        expect(await out('echo "$(false || echo c)"')).toEqual(['c']);
        expect(await out('echo "$(echo hello | cat)"')).toEqual(['hello']);
    });

    it('does not split on operators inside ${ } defaults', async () => {
        expect(await out('echo "${NOPE:-a;b}"')).toEqual(['a;b']);
        expect(await out('echo "${NOPE:-a|b}"')).toEqual(['a|b']);
    });

    it('still splits operators after a substitution', async () => {
        expect(await out('echo $(echo a) ; echo b')).toEqual(['a', 'b']);
        expect(await out('echo ${NOPE:-x} && echo y')).toEqual(['x', 'y']);
    });

    it('captured output containing ) } quotes and $ is not re-parsed', async () => {
        await shell.onCommand(`X=$(echo 'a) b} "c" $HOME')`);
        expect(shell.context.getVar('X')).toBe('a) b} "c" $HOME');
        expect(await out('echo "$X"')).toEqual(['a) b} "c" $HOME']);
    });

    it('captured multi-line output keeps its lines inside quotes', async () => {
        await shell.onCommand('X=$(echo a; echo b)');
        expect(await out('echo "$X"')).toEqual(['a', 'b']);
    });
});

describe('control flow typed at the prompt', () => {
    let shell;
    beforeEach(async () => {
        shell = await createShell({filesystem: {home: {sub: {}, 'f.txt': 'x'}}, cwd: '/home'});
    });

    const out = async cmd => {
        const res = await run(shell, cmd);
        expect(res.errors).toEqual([]);
        return res.output;
    };

    it('runs a one-line if/elif/else chain', async () => {
        const chain = x => `X=${x}; if [ $X = 1 ]; then echo one; elif [ $X = 2 ]; then echo two; else echo other; fi`;
        expect(await out(chain(1))).toEqual(['one']);
        expect(await out(chain(2))).toEqual(['two']);
        expect(await out(chain(3))).toEqual(['other']);
    });

    it('runs one-line if, for and while', async () => {
        expect(await out('if true; then echo yes; fi')).toEqual(['yes']);
        expect(await out('if false; then echo yes; else echo no; fi')).toEqual(['no']);
        expect(await out('for i in 1 2 3; do echo $i; done')).toEqual(['1', '2', '3']);
        expect(await out('i=0; while [ $i -lt 3 ]; do i=$((i + 1)); done; echo i=$i')).toEqual(['i=3']);
    });

    it('runs commands before and after a block on the same line', async () => {
        expect(await out('echo before; for i in a b; do echo $i; done; echo after')).toEqual(['before', 'a', 'b', 'after']);
    });

    it('runs a one-line case and function definition', async () => {
        expect(await out('case x in x) echo matched;; y) echo no;; esac')).toEqual(['matched']);
        await shell.onCommand('greet() { echo hello $1; }');
        expect(await out('greet world')).toEqual(['hello world']);
    });

    it('break works inside a block', async () => {
        expect(await out('for i in 1 2 3; do if [ $i = 2 ]; then break; fi; echo $i; done')).toEqual(['1']);
    });

    it('state changes made inside a block stick around', async () => {
        await shell.onCommand('for d in sub; do cd $d; done');
        expect((await out('pwd'))[0]).toBe('/home/sub');
        await shell.onCommand('if true; then MARK=set; fi');
        expect(shell.context.getVar('MARK')).toBe('set');
        await shell.onCommand('for i in 1 2 3; do LAST=$i; done');
        expect(shell.context.getVar('LAST')).toBe('3');
    });

    it('does not treat quoted keywords as a block', async () => {
        expect(await out('echo "if x; then y; fi"')).toEqual(['if x; then y; fi']);
    });

    it('sets the exit code from the last command in the block', async () => {
        await shell.onCommand('if true; then false; fi');
        expect(shell.lastCode).toBe(1);
        await shell.onCommand('if true; then true; fi');
        expect(shell.lastCode).toBe(0);
    });

    it('break outside a loop inside a block is reported', async () => {
        const res = await run(shell, 'if true; then break; fi');
        expect(res.errors.join(' ')).toMatch(/only meaningful in a for or while loop/);
        expect(res.exitCode).toBe(1);
    });

    it('runs blocks inside command substitution', async () => {
        expect(await out('echo $(if true; then echo inner; fi)')).toEqual(['inner']);
        expect(await out('X=$(for i in 1 2; do echo n$i; done); echo $X')).toEqual(['n1 n2']);
    });
});

describe('multi-line entry at the prompt', () => {
    let shell;
    let screen;
    beforeEach(async () => {
        shell = await createShell({filesystem: {home: {}}, cwd: '/home'});
        screen = '';
        shell.stdout.on('data', chunk => screen += chunk);
        await settle();
        screen = '';
    });

    const settle = () => new Promise(resolve => setTimeout(resolve, 40));
    const type = async text => {
        shell.stdinStream.pushData(text);
        await settle();
    };
    const lastPrompt = () => screen.split('\r\x1b[J').pop();

    it('shows a continuation prompt until the block is closed, then runs it', async () => {
        const lines = [];
        shell.on('stdOut', line => lines.push(line));

        await type('for i in 1 2\r');
        expect(lastPrompt()).toBe('> ');
        await type('do\r');
        expect(lastPrompt()).toBe('> ');
        await type('echo $i\r');
        expect(lines).toEqual([]);
        await type('done\r');

        expect(lines).toEqual(['1', '2']);
        expect(lastPrompt()).toMatch(/\$ $/);
    });

    it('collects an if block across lines', async () => {
        const lines = [];
        shell.on('stdOut', line => lines.push(line));
        await type('if true\r');
        await type('then\r');
        await type('echo yes\r');
        await type('else\r');
        await type('echo no\r');
        await type('fi\r');
        expect(lines).toEqual(['yes']);
    });

    it('collects nested blocks and case blocks', async () => {
        const lines = [];
        shell.on('stdOut', line => lines.push(line));
        await type('for i in a b; do\r');
        await type('if [ $i = b ]; then\r');
        await type('echo got-b\r');
        await type('fi\r');
        await type('done\r');
        expect(lines).toEqual(['got-b']);

        lines.length = 0;
        await type('case x in\r');
        await type('x) echo hit;;\r');
        await type('esac\r');
        expect(lines).toEqual(['hit']);
    });

    it('collects a function definition across lines and keeps it', async () => {
        const lines = [];
        shell.on('stdOut', line => lines.push(line));
        await type('hi() {\r');
        await type('echo hi-$1\r');
        await type('}\r');
        await type('hi there\r');
        expect(lines).toEqual(['hi-there']);
    });

    it('runs a complete one-liner straight away without a continuation prompt', async () => {
        const lines = [];
        shell.on('stdOut', line => lines.push(line));
        await type('if true; then echo now; fi\r');
        expect(lines).toEqual(['now']);
        expect(screen).not.toContain('> ');
    });

    it('Ctrl-C abandons a half typed block', async () => {
        const lines = [];
        shell.on('stdOut', line => lines.push(line));
        await type('if true\r');
        await type('\x03');
        expect(lastPrompt()).toMatch(/\$ $/);
        await type('echo plain\r');
        expect(lines).toEqual(['plain']);
    });

    it('Ctrl-C stops a running loop and returns the prompt', async () => {
        let ticks = 0;
        shell.on('stdOut', () => ticks++);
        await type('while true; do echo tick; done\r');
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(ticks).toBeGreaterThan(0);

        await type('\x03');
        const after = ticks;
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(ticks).toBe(after);
        expect(shell._working).toBe(false);
        expect(lastPrompt()).toMatch(/\$ $/);
    });

    it('state from a multi-line block sticks around', async () => {
        await type('for i in 1 2 3; do\r');
        await type('LAST=$i\r');
        await type('done\r');
        expect(shell.context.getVar('LAST')).toBe('3');
    });
});

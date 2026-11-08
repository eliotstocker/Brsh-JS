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


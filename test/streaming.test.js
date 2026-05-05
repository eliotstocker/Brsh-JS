import { createRequire } from 'module';
import { describe, it, expect, beforeEach } from 'vitest';
import { createShell } from './helpers.js';

// Use createRequire so Command shares the same CJS module instance as
// index.js's internal require() — required for instanceof checks.
const require = createRequire(import.meta.url);
const Command = require('../lib/Command.js');

// A command that flushes output in chunks before completing.
class ProgressCommand extends Command {
    get name() { return 'progress'; }

    run() {
        this.stdOut = 'step:1';
        this.flush();
        this.stdOut = 'step:2';
        this.flush();
        // step:3 arrives via the resolved value (not flushed early)
        return Promise.resolve('step:3');
    }
}

// A command with an async pause between flushes.
class AsyncProgressCommand extends Command {
    get name() { return 'async-progress'; }

    run() {
        return new Promise((resolve) => {
            this.stdOut = 'async:1';
            this.flush();

            setTimeout(() => {
                this.stdOut = 'async:2';
                this.flush();
                resolve('async:3');
            }, 20);
        });
    }
}

describe('real-time streaming output', () => {
    let shell;

    beforeEach(async () => {
        shell = await createShell({
            filesystem: {
                bin: {
                    progress: ProgressCommand,
                    'async-progress': AsyncProgressCommand
                }
            }
        });
    });

    it('receives flushed output before the command finishes (sync)', async () => {
        const received = [];
        shell.on('stdOut', (line) => received.push(line));
        await shell.onCommand('./bin/progress');
        shell.removeAllListeners('stdOut');

        expect(received).toContain('step:1');
        expect(received).toContain('step:2');
        expect(received).toContain('step:3');
        expect(received.indexOf('step:1')).toBeLessThan(received.indexOf('step:3'));
        expect(received.indexOf('step:2')).toBeLessThan(received.indexOf('step:3'));
    });

    it('receives flushed output in order (sync)', async () => {
        const received = [];
        shell.on('stdOut', (line) => received.push(line));
        await shell.onCommand('./bin/progress');
        shell.removeAllListeners('stdOut');

        expect(received).toEqual(['step:1', 'step:2', 'step:3']);
    });

    it('receives flushed output before the command finishes (async)', async () => {
        const received = [];
        shell.on('stdOut', (line) => received.push(line));
        await shell.onCommand('./bin/async-progress');
        shell.removeAllListeners('stdOut');

        expect(received).toContain('async:1');
        expect(received).toContain('async:2');
        expect(received).toContain('async:3');
        expect(received.indexOf('async:1')).toBeLessThan(received.indexOf('async:3'));
    });

    it('does not double-emit flushed lines in the final output', async () => {
        const received = [];
        shell.on('stdOut', (line) => received.push(line));
        await shell.onCommand('./bin/progress');
        shell.removeAllListeners('stdOut');

        expect(received.filter((l) => l === 'step:1').length).toBe(1);
        expect(received.filter((l) => l === 'step:2').length).toBe(1);
        expect(received.filter((l) => l === 'step:3').length).toBe(1);
    });

    it('read command streams its prompt before blocking', () => {
        return new Promise((resolve, reject) => {
            const tid = setTimeout(() => reject(new Error('prompt not streamed')), 500);
            shell.once('stdErr', (line) => {
                clearTimeout(tid);
                expect(line).toBe('> ');
                shell.onInput('x');
                resolve();
            });
            shell.onCommand('read -p "> " -n 1 V');
        });
    });
});

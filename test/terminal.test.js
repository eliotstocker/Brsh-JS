import { describe, it, expect, beforeEach } from 'vitest';
import Shell from '../index.js';
import Terminal from '../lib/Terminal.js';
import Pico from '../demo/pico.js';

function createMockDom() {
    const windowListeners = {};
    const makeElement = (tag = 'div') => {
        const el = {
            tagName: tag.toUpperCase(),
            style: {},
            className: '',
            textContent: '',
            _innerHTML: '',
            children: [],
            parentNode: null,
            classList: {
                _set: new Set(),
                add(c) { this._set.add(c); },
                remove(c) { this._set.delete(c); },
                contains(c) { return this._set.has(c); }
            },
            _listeners: {},
            appendChild(child) {
                child.parentNode = el;
                this.children.push(child);
                return child;
            },
            removeChild(child) {
                const idx = this.children.indexOf(child);
                if (idx !== -1) {
                    this.children.splice(idx, 1);
                    child.parentNode = null;
                }
                return child;
            },
            setAttribute(k, v) { this[k] = v; },
            addEventListener(ev, fn) {
                if (!this._listeners[ev]) this._listeners[ev] = [];
                this._listeners[ev].push(fn);
            },
            dispatchEvent(ev, payload = {}) {
                const fns = this._listeners[ev] || [];
                for (const fn of fns) fn(payload);
            },
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
            querySelectorAll: () => []
        };
        Object.defineProperty(el, 'innerHTML', {
            get() { return this._innerHTML; },
            set(v) { this._innerHTML = v; }
        });
        return el;
    };

    globalThis.window = {
        addEventListener(ev, fn) {
            if (!windowListeners[ev]) windowListeners[ev] = [];
            windowListeners[ev].push(fn);
        },
        removeEventListener(ev, fn) {
            const list = windowListeners[ev];
            if (!list) return;
            const i = list.indexOf(fn);
            if (i !== -1) list.splice(i, 1);
        },
        dispatchEvent(ev, payload = {}) {
            const fns = windowListeners[ev] || [];
            for (const fn of fns) fn(payload);
        }
    };

    globalThis.document = {
        createElement: (tag) => makeElement(tag),
        head: makeElement('head')
    };

    return { makeElement, windowListeners };
}

function waitForReady(shell) {
    return new Promise(resolve => {
        const check = status => {
            if (status === Shell.STATUS_READY) {
                shell.removeListener('status', check);
                resolve();
            }
        };
        shell.on('status', check);
    });
}

describe('Terminal decoupling and Shell resolution', () => {
    beforeEach(() => {
        createMockDom();
    });

    it('instantiates with options.cli directly', () => {
        delete globalThis.Shell;
        delete globalThis.shell;

        const customShell = new Shell({ cwd: '/test' });
        const term = new Terminal({
            el: document.createElement('div'),
            cli: customShell
        });

        expect(term.cli).toBe(customShell);
    });

    it('instantiates with options.Shell constructor', () => {
        delete globalThis.Shell;
        delete globalThis.shell;

        const term = new Terminal({
            el: document.createElement('div'),
            Shell: Shell,
            cwd: '/test'
        });

        expect(term.cli).toBeInstanceOf(Shell);
    });

    it('instantiates with globalThis.Shell fallback', () => {
        globalThis.Shell = Shell;

        const term = new Terminal({
            el: document.createElement('div'),
            cwd: '/test'
        });

        expect(term.cli).toBeInstanceOf(Shell);
    });

    it('throws a helpful error when no Shell or cli is available', () => {
        delete globalThis.Shell;
        delete globalThis.shell;

        expect(() => {
            new Terminal({
                el: document.createElement('div'),
                Shell: null
            });
        }).toThrow(/Shell is required by Terminal/);
    });

    it('can be required as a CommonJS module via dist/terminal.cjs.js', () => {
        const { createRequire } = require('module');
        const cjsRequire = createRequire(import.meta.url);
        const CjsTerminal = cjsRequire('../dist/terminal.cjs.js');
        const TermClass = CjsTerminal.default || CjsTerminal;
        expect(typeof TermClass).toBe('function');

        const customShell = new Shell({ cwd: '/test' });
        const term = new TermClass({
            el: document.createElement('div'),
            cli: customShell
        });
        expect(term.cli).toBe(customShell);
    });
});

describe('VT100 / ANSI Terminal Emulation & Line Rewriting', () => {
    let term;
    let container;

    beforeEach(() => {
        createMockDom();
        container = document.createElement('div');
        term = new Terminal({
            el: container,
            Shell: false,
            cols: 80,
            rows: 24,
            cursor: 'block'
        });
    });

    it('rewrites lines in-place using carriage return (\\r) and erase-in-line (\\x1b[K)', () => {
        term.write('Downloading: 10%');
        expect(term.getLineText(0)).toBe('Downloading: 10%');

        term.write('\rDownloading: 55% (fast)');
        expect(term.getLineText(0)).toBe('Downloading: 55% (fast)');

        term.write('\r\x1b[2KDone!');
        expect(term.getLineText(0)).toBe('Done!');
        expect(term.getLineText(1)).toBe('');
    });

    it('supports cursor addressing (CUP), relative movement (CUU/CUD/CUF/CUB), and save/restore (DECSC/DECRC)', () => {
        term.write('\x1b[5;10HHello');
        expect(term.getLineText(4)).toBe('         Hello');

        // Save cursor, jump to row 1 col 1, write Header, then restore cursor and continue writing
        term.write('\x1b7\x1b[1;1HHeader\x1b8 World!');
        expect(term.getLineText(0)).toBe('Header');
        expect(term.getLineText(4)).toBe('         Hello World!');

        // Move up 2 rows, back 6 cols
        term.write('\x1b[2A\x1b[6DAbove');
        expect(term.getLineText(2)).toBe('               Above');
    });

    it('supports DEC Special Graphics (ACS) box drawing characters used by blessed', () => {
        term.write('\x1b(0lqqqk\r\nx\x1b(BHi!\x1b(0x\r\nmqqqj\x1b(B');
        expect(term.getLineText(0)).toBe('┌───┐');
        expect(term.getLineText(1)).toBe('│Hi!│');
        expect(term.getLineText(2)).toBe('└───┘');
    });

    it('supports alternate screen buffer (\\x1b[?1049h / \\x1b[?1049l) and restores primary screen on exit', () => {
        term.writeln('Primary Line 1');
        term.writeln('Primary Line 2');
        expect(term.getLineText(0)).toBe('Primary Line 1');
        expect(term.getLineText(1)).toBe('Primary Line 2');

        // Enter alt screen
        term.write('\x1b[?1049h\x1b[1;1HFull Screen App Content');
        expect(term.screen.isAltScreen).toBe(true);
        expect(term.getLineText(0)).toBe('Full Screen App Content');
        expect(term.getLineText(1)).toBe('');

        // Exit alt screen -> primary buffer & cursor restored
        term.write('\x1b[?1049l');
        expect(term.screen.isAltScreen).toBe(false);
        expect(term.getLineText(0)).toBe('Primary Line 1');
        expect(term.getLineText(1)).toBe('Primary Line 2');
    });

    it('supports scroll regions (DECSTBM) and insert/delete lines & chars', () => {
        term.write('\x1b[1;1HFixed Header');
        term.write('\x1b[2;1HRow A');
        term.write('\x1b[3;1HRow B');
        term.write('\x1b[4;1HRow C');
        term.write('\x1b[5;1HFixed Footer');

        // Set scroll region to rows 2..4 and scroll up 1 line
        term.write('\x1b[2;4r\x1b[4;1H\nNew Row D');
        expect(term.getLineText(0)).toBe('Fixed Header');
        expect(term.getLineText(1)).toBe('Row B');
        expect(term.getLineText(2)).toBe('Row C');
        expect(term.getLineText(3)).toBe('New Row D');
        expect(term.getLineText(4)).toBe('Fixed Footer');

        // Reset scroll region and test insert/delete chars (ICH/DCH)
        term.write('\x1b[r\x1b[6;1HWorld\x1b[6;1H\x1b[6@Hello ');
        expect(term.getLineText(5)).toBe('Hello World');
        term.write('\x1b[6;1H\x1b[6P');
        expect(term.getLineText(5)).toBe('World');
    });

    it('renders SGR 16-color classes, 256-color palette, and 24-bit RGB styles', () => {
        term.write('\x1b[1;31mRedBold\x1b[0m \x1b[38;5;208mOrange256\x1b[0m \x1b[48;2;10;20;30mTrueBg\x1b[0m');
        const rowHtml = term.renderer._rowElements[0].innerHTML;
        expect(rowHtml).toContain('ansi-red-fg');
        expect(rowHtml).toContain('font-weight:bold');
        expect(rowHtml).toContain('color:rgb(255, 135, 0)');
        expect(rowHtml).toContain('background-color:rgb(10, 20, 30)');
    });

    it('replies to DSR (\\x1b[6n) cursor position and DA (\\x1b[c) queries via onData', () => {
        const responses = [];
        term.onData(d => responses.push(d));

        term.write('\x1b[4;12H\x1b[6n\x1b[c');
        expect(responses).toEqual(['\x1b[4;12R', '\x1b[?1;2c']);
    });
});

describe('HTTP / URL Auto-Linking and OSC 8 Hyperlinks', () => {
    let term;

    beforeEach(() => {
        createMockDom();
        term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 100,
            rows: 10
        });
    });

    it('auto-detects http/https/mailto/tel links and excludes trailing punctuation', () => {
        term.writeln('Visit https://example.com/docs/path?x=1, or mailto:test@example.com.');
        const html = term.renderer._rowElements[0].innerHTML;
        expect(html).toContain('<a href="https://example.com/docs/path?x=1" target="_blank" rel="noopener noreferrer" class="terminal__link">https://example.com/docs/path?x=1</a>,');
        expect(html).toContain('<a href="mailto:test@example.com" target="_blank" rel="noopener noreferrer" class="terminal__link">mailto:test@example.com</a>.');
    });

    it('renders OSC 8 explicit hyperlinks and blocks unsafe javascript: URLs', () => {
        term.writeln('\x1b]8;;https://vibestac.kr\x07VibeStack\x1b]8;;\x07 and \x1b]8;;javascript:alert(1)\x07Evil\x1b]8;;\x07');
        const html = term.renderer._rowElements[0].innerHTML;
        expect(html).toContain('<a href="https://vibestac.kr" target="_blank" rel="noopener noreferrer" class="terminal__link">VibeStack</a>');
        expect(html).not.toContain('javascript:alert');
    });
});

describe('Mouse Tracking & Scrollback Support', () => {
    let term;

    beforeEach(() => {
        createMockDom();
        term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 80,
            rows: 10
        });
    });

    it('encodes SGR mouse press, drag, release, and wheel events when ?1002h and ?1006h are enabled', () => {
        const events = [];
        term.onData(d => events.push(d));

        term.write('\x1b[?1002h\x1b[?1006h');
        term.sendMouse('mousedown', { button: 0, col: 12, row: 5 });
        term.sendMouse('mousemove', { button: 0, col: 15, row: 5 });
        term.sendMouse('mouseup', { button: 0, col: 15, row: 5 });
        term.sendMouse('wheel', { col: 10, row: 3, deltaY: -100 });

        expect(events).toEqual([
            '\x1b[<0;12;5M',
            '\x1b[<32;15;5M',
            '\x1b[<0;15;5m',
            '\x1b[<64;10;3M'
        ]);
    });

    it('scrolls the primary scrollback buffer on mouse wheel when mouse tracking is off', () => {
        for (let i = 1; i <= 15; i++) {
            term.writeln(`Line ${i}`);
        }
        // Bottom of viewport shows Line 7..15 + empty prompt line
        expect(term.screen.viewportOffset).toBe(0);
        term.sendMouse('wheel', { deltaY: -120 });
        expect(term.screen.viewportOffset).toBe(3);

        // Typing snaps viewport back to bottom
        term.sendKey('a');
        expect(term.screen.viewportOffset).toBe(0);
    });
});

describe('brsh Shell Integration, Line Editing, and Full-Screen Apps', () => {
    let shell;
    let term;

    beforeEach(async () => {
        createMockDom();
        shell = new Shell({
            filesystem: {
                root: {
                    'hello.txt': 'Hello from file'
                }
            },
            cwd: '/root',
            hostname: 'brsh'
        });
        shell.context.setCommand(Pico);
        const ready = waitForReady(shell);
        term = new Terminal({
            el: document.createElement('div'),
            cli: shell,
            cols: 80,
            rows: 24,
            cursor: 'blink'
        });
        await ready;
    });

    it('supports interactive line editing, cursor movement, history, and running commands', async () => {
        expect(term.getLineText(0)).toBe('brsh:root$');

        for (const ch of 'echo world') term.sendKey(ch);
        expect(term.getLineText(0)).toBe('brsh:root$ echo world');

        // Move back one word (Alt+ArrowLeft) and insert "hello "
        term.sendKey('ArrowLeft', { alt: true });
        for (const ch of 'hello ') term.sendKey(ch);
        expect(term.getLineText(0)).toBe('brsh:root$ echo hello world');

        const done = waitForReady(shell);
        term.sendKey('Enter');
        await done;

        expect(term.getLineText(0)).toBe('brsh:root$ echo hello world');
        expect(term.getLineText(1)).toBe('hello world');
        expect(term.getLineText(2)).toBe('brsh:root$');

        // Navigate history up
        term.sendKey('ArrowUp');
        expect(term.getLineText(2)).toBe('brsh:root$ echo hello world');

        // Delete word with Alt+Backspace
        term.sendKey('Backspace', { alt: true });
        expect(term.getLineText(2)).toBe('brsh:root$ echo hello');
    });

    it('edits wrapped input lines in-place on backspace without repeating onto next line', async () => {
        const narrowShell = new Shell({
            filesystem: { root: {} },
            cwd: '/root',
            hostname: 'brsh'
        });
        const ready = waitForReady(narrowShell);
        // Narrow terminal to 40 columns so input easily wraps
        const narrowTerm = new Terminal({
            el: document.createElement('div'),
            cli: narrowShell,
            cols: 40,
            rows: 10
        });
        await ready;

        // Prompt is 'brsh:root$ ' (11 chars). Typing 35 chars = 46 chars total (row 0 has 40, row 1 has 6).
        for (const ch of '12345678901234567890123456789012345') narrowTerm.sendKey(ch);
        expect(narrowTerm.getLineText(0)).toBe('brsh:root$ 12345678901234567890123456789');
        expect(narrowTerm.getLineText(1)).toBe('012345');
        expect(narrowTerm.screen.cursorRow).toBe(1);

        // Backspace should edit row 1 in-place rather than repeating the line onto row 2
        narrowTerm.sendKey('Backspace');
        expect(narrowTerm.getLineText(0)).toBe('brsh:root$ 12345678901234567890123456789');
        expect(narrowTerm.getLineText(1)).toBe('01234');
        expect(narrowTerm.getLineText(2)).toBe('');
        expect(narrowTerm.screen.cursorRow).toBe(1);

        // Backspacing across the wrap boundary restores cursor cleanly back to row 0
        for (let i = 0; i < 5; i++) narrowTerm.sendKey('Backspace');
        expect(narrowTerm.getLineText(0)).toBe('brsh:root$ 12345678901234567890123456789');
        expect(narrowTerm.getLineText(1)).toBe('');
        narrowTerm.sendKey('Backspace');
        expect(narrowTerm.getLineText(0)).toBe('brsh:root$ 1234567890123456789012345678');
        expect(narrowTerm.screen.cursorRow).toBe(0);
        expect(narrowTerm.screen.cursorCol).toBe(39);
    });

    it('keeps cursor element visible when arrowing through input in blink mode', async () => {
        expect(term.renderer.cursorStyle).toBe('blink');
        for (const ch of 'abcde') term.sendKey(ch);

        // Arrow left across input characters; cursor span is rendered on each step
        const rowEl = term._cmdList.children[0];
        term.sendKey('ArrowLeft');
        expect(rowEl.innerHTML).toContain('class="terminal__cursor blink">e</span>');

        term.sendKey('ArrowLeft');
        expect(rowEl.innerHTML).toContain('class="terminal__cursor blink">d</span>');
    });

    it('runs pico in the alternate screen buffer and restores shell screen on exit', async () => {
        await shell.onCommand('echo before-pico');
        expect(term.getLineText(0)).toContain('before-pico');

        // Start pico
        const picoDone = waitForReady(shell);
        shell.onCommand('pico notes.txt');
        await new Promise(r => setTimeout(r, 20));

        expect(term.screen.isAltScreen).toBe(true);
        expect(term.getLineText(0)).toContain('pico  notes.txt');

        // Type inside pico, save (^S), and exit (^X)
        for (const ch of 'Real terminal text') term.sendKey(ch);
        term.sendKey('s', { ctrl: true });
        term.sendKey('x', { ctrl: true });
        await picoDone;

        expect(term.screen.isAltScreen).toBe(false);
        expect(term.getLineText(0)).toContain('before-pico');
        expect(shell.context.fs._getFileRaw('/root/notes.txt')).toBe('Real terminal text');
    });

    it('allows a brsh Command to control the terminal directly via this.stdout and this.stdin', async () => {
        class BlessedLikeCmd extends Shell.Command {
            static get name() { return 'tuicmd'; }
            run() {
                return new Promise(resolve => {
                    this.stdin.setEncoding('utf8');
                    this.stdin.setRawMode(true);
                    this.stdout.write(
                        '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H' +
                        '\x1b(0lqqqqqqqqqqqqqqk\x1b(B\r\n' +
                        '\x1b(0x\x1b(B Status: IDLE \x1b(0x\x1b(B\r\n' +
                        '\x1b(0mqqqqqqqqqqqqqqj\x1b(B'
                    );

                    this.stdin.on('data', (chunk) => {
                        if (chunk.startsWith('\x1b[<0;')) {
                            // Mouse click received via this.stdin -> rewrite row 2 in-place via this.stdout
                            this.stdout.write('\x1b[2;3HStatus: CLICK');
                        } else if (chunk === 'q') {
                            this.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
                            this.stdin.setRawMode(false);
                            resolve();
                        }
                    });
                });
            }
        }

        shell.context.setCommand(BlessedLikeCmd);
        const cmdDone = waitForReady(shell);
        shell.onCommand('tuicmd');
        await new Promise(r => setTimeout(r, 20));

        expect(term.screen.isAltScreen).toBe(true);
        expect(term.getLineText(0)).toBe('┌──────────────┐');
        expect(term.getLineText(1)).toBe('│ Status: IDLE │');
        expect(term.getLineText(2)).toBe('└──────────────┘');

        // Click inside the TUI box -> routed through shell.stdin -> cmd.stdin
        term.sendMouse('mousedown', { button: 0, col: 5, row: 2 });
        expect(term.getLineText(1)).toBe('│ Status: CLICK│');

        // Press 'q' to exit TUI command
        term.sendKey('q');
        await cmdDone;

        expect(term.screen.isAltScreen).toBe(false);
        expect(term.getLineText(0)).toContain('brsh:root$ tuicmd');
    });

    it('runs a full-screen ReplCommand (used by wbt interactive REPLs) and restores screen on exit', async () => {
        class DemoRepl extends Shell.ReplCommand {
            static get name() { return 'demorepl'; }
            shouldBeInteractive() { return true; }
            getReplTitle() { return 'Demo Interactive REPL'; }
            getReplPrompt() { return 'demo> '; }
            async evaluateReplLine(line) {
                return { output: [`result: ${line.toUpperCase()}`] };
            }
        }

        shell.context.setCommand(DemoRepl);
        const replDone = waitForReady(shell);
        shell.onCommand('demorepl');
        await new Promise(r => setTimeout(r, 30));

        expect(term.screen.isAltScreen).toBe(true);
        expect(term.getLineText(0)).toContain('Demo Interactive REPL');

        for (const ch of 'hello repl') term.sendKey(ch);
        term.sendKey('Enter');
        await new Promise(r => setTimeout(r, 30));

        expect(term.getScreenText()).toContain('demo> hello repl');
        expect(term.getScreenText()).toContain('result: HELLO REPL');

        // Exit REPL with Ctrl+D
        term.sendKey('d', { ctrl: true });
        await replDone;

        expect(term.screen.isAltScreen).toBe(false);
        expect(term.getLineText(0)).toContain('brsh:root$ demorepl');
    });
});

describe('TUI (blessed-style) Application over Virtual TTY & Real zsh PTY Compatibility', () => {
    beforeEach(() => {
        createMockDom();
    });

    it('renders a blessed-style TUI application with box borders, scroll regions, mouse & keyboard over createTty()', () => {
        const term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 40,
            rows: 10
        });

        term.writeln('Shell history before TUI');
        const tty = term.createTty();
        expect(tty.stdin.isTTY).toBe(true);
        expect(tty.stdout.isTTY).toBe(true);
        expect(tty.stdout.getWindowSize()).toEqual([40, 10]);

        const receivedInput = [];
        tty.stdin.setEncoding('utf8');
        tty.stdin.on('data', d => receivedInput.push(d));

        // Simulate blessed entering alt screen, hiding cursor, enabling SGR mouse, and drawing a bordered box
        tty.stdout.write(
            '\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H' +
            '\x1b(0lqqqqqqqqqqqqqqqqqqk\x1b(B\r\n' +
            '\x1b(0x\x1b(B \x1b[1;32mBlessed TUI Box\x1b[0m  \x1b(0x\x1b(B\r\n' +
            '\x1b(0x\x1b(B > Item 1         \x1b(0x\x1b(B\r\n' +
            '\x1b(0x\x1b(B   Item 2         \x1b(0x\x1b(B\r\n' +
            '\x1b(0mqqqqqqqqqqqqqqqqqqj\x1b(B'
        );

        expect(term.screen.isAltScreen).toBe(true);
        expect(term.screen.cursorVisible).toBe(false);
        expect(term.getLineText(0)).toBe('┌──────────────────┐');
        expect(term.getLineText(1)).toBe('│ Blessed TUI Box  │');
        expect(term.getLineText(2)).toBe('│ > Item 1         │');
        expect(term.getLineText(3)).toBe('│   Item 2         │');
        expect(term.getLineText(4)).toBe('└──────────────────┘');

        // Send key navigation and mouse click to the TUI app
        term.sendKey('ArrowDown');
        term.sendMouse('mousedown', { button: 0, col: 5, row: 4 });
        expect(receivedInput).toEqual(['\x1b[B', '\x1b[<0;5;4M']);

        // Update only rows 3 & 4 in-place via cursor addressing (like blessed smartCSR)
        tty.stdout.write('\x1b[3;3H  Item 1\x1b[4;3H> Item 2');
        expect(term.getLineText(2)).toBe('│   Item 1         │');
        expect(term.getLineText(3)).toBe('│ > Item 2         │');

        // Exit TUI app
        tty.stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l');
        tty.dispose();

        expect(term.screen.isAltScreen).toBe(false);
        expect(term.getLineText(0)).toBe('Shell history before TUI');
    });

    it('spawns and interacts with a real /bin/zsh process in a PTY', async () => {
        const term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 80,
            rows: 24
        });

        const { pty, detach } = term.spawn('/bin/zsh', ['-f'], {
            env: { PS1: 'zsh-pty$ ' }
        });

        const waitForScreenMatch = (regex, timeoutMs = 4000) => {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                const timer = setInterval(() => {
                    const text = term.getScreenText();
                    if (regex.test(text)) {
                        clearInterval(timer);
                        resolve(text);
                    } else if (Date.now() - start > timeoutMs) {
                        clearInterval(timer);
                        reject(new Error(`Timed out waiting for ${regex}. Screen:\n${text}`));
                    }
                }, 20);
            });
        };

        try {
            await waitForScreenMatch(/zsh-pty\$/);

            // Run a command and an in-place carriage-return line rewrite in real zsh
            term.onCommand('printf "step1\\rstep2-rewritten\\n"; echo ZSH_OK_$((20 + 22))');
            const screenText = await waitForScreenMatch(/ZSH_OK_42/);

            expect(term.getLineText(1)).toBe('step2-rewritten');
            expect(screenText).toContain('ZSH_OK_42');
        } finally {
            detach();
            pty.kill();
        }
    });

    it('runs a real OS ncurses (Python curses) full-screen application in a PTY and restores screen on exit', async () => {
        const term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 60,
            rows: 15
        });

        term.writeln('Primary shell line before ncurses');

        const cursesScript = [
            'import curses',
            'def main(stdscr):',
            '    curses.curs_set(0)',
            '    stdscr.clear()',
            '    win = curses.newwin(6, 30, 2, 4)',
            '    win.box()',
            '    win.addstr(1, 2, "Real NCURSES Window")',
            '    win.addstr(3, 2, "Press j to update, q to quit")',
            '    stdscr.refresh()',
            '    win.refresh()',
            '    while True:',
            '        ch = win.getch()',
            '        if ch == ord("j"):',
            '            win.addstr(2, 2, "State: UPDATED")',
            '            win.refresh()',
            '        elif ch == ord("q"):',
            '            break',
            'curses.wrapper(main)'
        ].join('\n');

        const { pty, detach } = term.spawn('python3', ['-c', cursesScript]);

        const waitForScreen = (predicate, timeoutMs = 4000) => {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                const timer = setInterval(() => {
                    if (predicate()) {
                        clearInterval(timer);
                        resolve();
                    } else if (Date.now() - start > timeoutMs) {
                        clearInterval(timer);
                        reject(new Error(`Timed out waiting for curses screen:\n${term.getScreenText()}`));
                    }
                }, 20);
            });
        };

        try {
            await waitForScreen(() => term.getScreenText().includes('Real NCURSES Window'));
            expect(term.screen.isAltScreen).toBe(true);
            expect(term.getLineText(2)).toContain('┌────────────────────────────┐');
            expect(term.getLineText(3)).toContain('│ Real NCURSES Window        │');

            // Send 'j' keystroke to update window in-place via ncurses cursor addressing
            term.sendKey('j');
            await waitForScreen(() => term.getScreenText().includes('State: UPDATED'));
            expect(term.getLineText(4)).toContain('│ State: UPDATED             │');

            // Send 'q' keystroke to exit ncurses and restore primary screen
            term.sendKey('q');
            await waitForScreen(() => !term.screen.isAltScreen);
            expect(term.getLineText(0)).toBe('Primary shell line before ncurses');
        } finally {
            detach();
            pty.kill();
        }
    });
});

describe('Output Typing Animation Suppression', () => {
    beforeEach(() => {
        createMockDom();
    });

    it('renders user typing input instantly even when outputAnimation is "type"', async () => {
        const shell = new Shell({
            filesystem: { root: {} },
            cwd: '/root',
            hostname: 'brsh'
        });
        const ready = waitForReady(shell);

        const term = new Terminal({
            el: document.createElement('div'),
            cli: shell,
            cols: 80,
            rows: 24,
            outputAnimation: 'type',
            animateSpeed: 1
        });
        await ready;

        try {
            // Normal multi-line output is queued for typing animation (not rendered synchronously)
            term.writeln('Animated background output line');
            expect(term.getScreenText()).not.toContain('Animated background output line');

            // User typing into the terminal flushes pending animation and renders keystrokes synchronously
            term.sendKey('e');
            term.sendKey('c');
            term.sendKey('h');
            term.sendKey('o');
            expect(term.getScreenText()).toContain('brsh:root$ echo');
        } finally {
            term.reset();
        }
    });

    it('renders same-line rewrites (\\r, \\x1b[K) instantly without re-animating the line', () => {
        const term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 60,
            rows: 10,
            outputAnimation: 'type',
            animateSpeed: 1
        });

        try {
            term.write('\rDownloading: [###       ] 30%\x1b[K');
            expect(term.getLineText(0)).toBe('Downloading: [###       ] 30%');

            term.write('\rDownloading: [#######   ] 70%\x1b[K');
            expect(term.getLineText(0)).toBe('Downloading: [#######   ] 70%');

            term.write('\rDownloading: [##########] 100%\x1b[K');
            expect(term.getLineText(0)).toBe('Downloading: [##########] 100%');
        } finally {
            term.reset();
        }
    });

    it('renders full-screen apps instantly without typing animation', () => {
        const term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 60,
            rows: 10,
            outputAnimation: 'type',
            animateSpeed: 1
        });

        try {
            // Entering alternate screen buffer + rendering full screen happens synchronously on write()
            term.write('\x1b[?1049h\x1b[2J\x1b[HFull Screen Header\r\nBody Row 1');
            expect(term.screen.isAltScreen).toBe(true);
            expect(term.getLineText(0)).toBe('Full Screen Header');
            expect(term.getLineText(1)).toBe('Body Row 1');

            // Updating inside the full-screen app is also synchronous
            term.write('\x1b[2;1HBody Row 1 Updated');
            expect(term.getLineText(1)).toBe('Body Row 1 Updated');

            // Exiting alternate screen buffer is synchronous
            term.write('\x1b[?1049l');
            expect(term.screen.isAltScreen).toBe(false);
        } finally {
            term.reset();
        }
    });
});

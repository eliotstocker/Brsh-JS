import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
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
            removeEventListener(ev, fn) {
                const list = this._listeners[ev];
                if (!list) return;
                const i = list.indexOf(fn);
                if (i !== -1) list.splice(i, 1);
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

    it('runs nano text editor in Terminal alternate screen and restores screen on exit', async () => {
        const FIXTURE_NANO_WASM = path.resolve(import.meta.dirname, 'fixtures/nano.wasm');
        if (!fs.existsSync(FIXTURE_NANO_WASM)) return;
        const bytes = fs.readFileSync(FIXTURE_NANO_WASM);
        const Wbt = (await import('../lib/wbt/index.js')).default.configure({
            fetch: async () => ({
                ok: true,
                status: 200,
                arrayBuffer: async () => bytes.buffer
            })
        });
        shell.context.setCommand(Wbt);
        await shell.onCommand('wbt install nano');

        const nanoDone = waitForReady(shell);
        shell.onCommand('nano');
        await new Promise(r => setTimeout(r, 80));

        expect(term.screen.isAltScreen).toBe(true);
        expect(term.getScreenText()).toContain('GNU nano 8.0');

        // Exit nano with Ctrl+X
        term.sendKey('x', { ctrl: true });
        await nanoDone;

        expect(term.screen.isAltScreen).toBe(false);
    });

    it('runs nano text editor opening a file and displaying its content', async () => {
        const FIXTURE_NANO_WASM = path.resolve(import.meta.dirname, 'fixtures/nano.wasm');
        if (!fs.existsSync(FIXTURE_NANO_WASM)) return;
        const bytes = fs.readFileSync(FIXTURE_NANO_WASM);
        const Wbt = (await import('../lib/wbt/index.js')).default.configure({
            fetch: async () => ({
                ok: true,
                status: 200,
                arrayBuffer: async () => bytes.buffer
            })
        });
        shell.context.setCommand(Wbt);
        await shell.onCommand('wbt install nano');

        shell.context.fs.setFileByPath('greeting.txt', 'Hello from inside nano buffer!', true);

        const nanoDone = waitForReady(shell);
        shell.onCommand('nano greeting.txt');
        await new Promise(r => setTimeout(r, 80));

        expect(term.screen.isAltScreen).toBe(true);
        expect(term.getScreenText()).toContain('greeting.txt');
        expect(term.getScreenText()).toContain('Hello from inside nano buffer!');
        expect(term.getScreenText()).not.toContain('does not exist');

        // Exit nano with Ctrl+X
        term.sendKey('x', { ctrl: true });
        await nanoDone;

        expect(term.screen.isAltScreen).toBe(false);
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

    it('spawns and interacts with a real shell process in a PTY', async () => {
        const req = typeof require === 'function' ? require : null;
        const fs = req ? req('fs') : null;
        const candidates = [
            { cmd: '/bin/zsh', args: ['-f'], prompt: 'zsh-pty$ ', promptRegex: /zsh-pty\$/ },
            { cmd: '/usr/bin/zsh', args: ['-f'], prompt: 'zsh-pty$ ', promptRegex: /zsh-pty\$/ },
            { cmd: '/bin/bash', args: ['--norc', '--noprofile'], prompt: 'bash-pty$ ', promptRegex: /bash-pty\$/ },
            { cmd: '/usr/bin/bash', args: ['--norc', '--noprofile'], prompt: 'bash-pty$ ', promptRegex: /bash-pty\$/ },
            { cmd: '/bin/sh', args: [], prompt: 'sh-pty$ ', promptRegex: /sh-pty\$/ }
        ];
        const match = candidates.find(c => fs && fs.existsSync(c.cmd));
        if (!match) return;

        const term = new Terminal({
            el: document.createElement('div'),
            Shell: false,
            cols: 80,
            rows: 24
        });

        const { pty, detach } = term.spawn(match.cmd, match.args, {
            env: { PS1: match.prompt }
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
            await waitForScreenMatch(match.promptRegex);

            // Run a command and an in-place carriage-return line rewrite in real shell
            term.onCommand('printf "step1\\rstep2-rewritten\\n"; echo SHELL_OK_$((20 + 22))');
            const screenText = await waitForScreenMatch(/SHELL_OK_42/);

            expect(term.getLineText(1)).toBe('step2-rewritten');
            expect(screenText).toContain('SHELL_OK_42');
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

    describe('mobileInput and destroy cleanup', () => {
        it('anchors off-screen input at fixed (0, 0) and uses preventScroll', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const input = term._mobileInputElement;
            expect(input).toBeDefined();
            expect(input.style.position).toBe('fixed');
            expect(input.style.top).toBe('0');
            expect(input.style.left).toBe('0');
            expect(input.style.width).toBe('0');
            expect(input.style.height).toBe('0');
            expect(input.style.opacity).toBe('0');
            expect(input.style.pointerEvents).toBe('none');
            expect(input.style.zIndex).toBe('-1');
            expect(input['aria-hidden']).toBe('true');
            expect(input.tabindex).toBe('-1');

            let focusedWith = null;
            input.focus = (opts) => {
                focusedWith = opts;
            };

            // Clicking terminal focuses with preventScroll: true
            el.dispatchEvent('click', { target: el });
            expect(focusedWith).toEqual({ preventScroll: true });

            // Clicking a link does not trigger focus
            focusedWith = null;
            const link = document.createElement('a');
            el.dispatchEvent('click', { target: link });
            expect(focusedWith).toBeNull();

            // Destroy removes input from DOM and cleans up
            expect(el.children).toContain(input);
            term.destroy();
            expect(el.children).not.toContain(input);
            expect(term._mobileInputElement).toBeNull();
        });

        it('disables autocapitalize, autocorrect, autocomplete, and spellcheck on mobile input', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const input = term._mobileInputElement;
            expect(input.autocapitalize).toBe('none');
            expect(input.autocorrect).toBe('off');
            expect(input.autocomplete).toBe('off');
            expect(input.spellcheck).toBe('false');
            expect(input.enterkeyhint).toBe('go');
            term.destroy();
        });

        it('handles mobile character typing when characters are prepended due to zero caret', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const input = term._mobileInputElement;
            const received = [];
            term.onData((data) => received.push(data));

            // Type 'h'
            input.value = 'h';
            input.dispatchEvent('input');

            // Type 'e' (prepended at offset 0 due to zero-size input caret, value becomes 'eh')
            input.value = 'eh';
            input.dispatchEvent('input');

            // Type 'l' (prepended at offset 0, value becomes 'leh')
            input.value = 'leh';
            input.dispatchEvent('input');

            // Type 'p' (prepended at offset 0, value becomes 'pleh')
            input.value = 'pleh';
            input.dispatchEvent('input');

            expect(received).toEqual(['h', 'e', 'l', 'p']);
            term.destroy();
        });

        it('handles mobile typing via inputType insertText and e.data', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const input = term._mobileInputElement;
            const received = [];
            term.onData((data) => received.push(data));

            input.value = 'a';
            input.dispatchEvent('input', { inputType: 'insertText', data: 'a' });

            input.value = 'ab';
            input.dispatchEvent('input', { inputType: 'insertText', data: 'b' });

            input.value = 'abc';
            input.dispatchEvent('input', { inputType: 'insertText', data: 'c' });

            expect(received).toEqual(['a', 'b', 'c']);
            term.destroy();
        });

        it('handles mobile backspace and Enter', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const input = term._mobileInputElement;
            const received = [];
            term.onData((data) => received.push(data));

            // Type 'hi'
            input.value = 'hi';
            input.dispatchEvent('input', { inputType: 'insertText', data: 'hi' });

            // Backspace via inputType
            input.value = 'h';
            input.dispatchEvent('input', { inputType: 'deleteContentBackward' });

            // Enter via insertLineBreak
            input.dispatchEvent('input', { inputType: 'insertLineBreak' });

            expect(received).toEqual(['hi', '\x7f', '\r']);
            expect(input.value).toBe('');
            expect(term._mobileInputBuffer).toBe('');

            term.destroy();
        });

        it('handles Android keyup with Unidentified via diff', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const input = term._mobileInputElement;
            const received = [];
            term.onData((data) => received.push(data));

            input.value = 'x';
            input.dispatchEvent('keyup', { key: 'Unidentified' });

            input.value = 'yx'; // prepended 'y'
            input.dispatchEvent('keyup', { key: 'Unidentified' });

            expect(received).toEqual(['x', 'y']);
            term.destroy();
        });
    });

    describe('Terminal Resizing and Content Preservation', () => {
        it('preserves line content cut off when resizing smaller, and restores it when resized bigger', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                cols: 80,
                rows: 24
            });

            const longLine = 'Email: eliot@piratemedia.tv (mailto:eliot@piratemedia.tv)';
            term.write(longLine + '\r\n');

            expect(term.getLineText(0)).toBe(longLine);

            // Resize down to 32 columns: reflows overflow onto next row
            term.resize(32, 24);
            expect(term.cols).toBe(32);
            expect(term.getLineText(0)).toBe(longLine.slice(0, 32));
            expect(term.getLineText(1)).toBe(longLine.slice(32));

            // In DOM, the reflowed rows are rendered
            expect(term.renderer._rowElements[0].innerHTML).toContain('Email: eliot@piratemedia.tv (mai');
            expect(term.renderer._rowElements[1].innerHTML).toContain('lto:eliot@piratemedia.tv)');

            // Resize back bigger to 80 columns: the cut off text unwraps and is fully restored
            term.resize(80, 24);
            expect(term.cols).toBe(80);
            expect(term.getLineText(0)).toBe(longLine);
            expect(term.getLineText(1)).toBe('');

            // Multiple resize cycles
            term.resize(20, 24);
            expect(term.getLineText(0)).toBe(longLine.slice(0, 20));
            expect(term.getLineText(1)).toBe(longLine.slice(20, 40));
            expect(term.getLineText(2)).toBe(longLine.slice(40));

            term.resize(100, 24);
            expect(term.getLineText(0)).toBe(longLine);
            expect(term.getLineText(1)).toBe('');
            expect(term.getLineText(2)).toBe('');

            term.destroy();
        });

        it('clears reflowed line when erased with erase-in-line', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                cols: 80,
                rows: 24
            });

            const longLine = 'Email: eliot@piratemedia.tv (mailto:eliot@piratemedia.tv)';
            term.write(longLine);

            // Resize to 32 cols: wraps onto row 0 and 1
            term.resize(32, 24);
            expect(term.getLineText(0)).toBe(longLine.slice(0, 32));
            expect(term.getLineText(1)).toBe(longLine.slice(32));

            // Move cursor to start of row 0 and erase row 0
            term.write('\x1b[H\x1b[K');
            expect(term.getLineText(0)).toBe('');

            term.destroy();
        });

        it('measures initial dimensions before attaching cli and subtracts CSS padding', () => {
            const el = document.createElement('div');
            el.clientWidth = 1020;
            el.clientHeight = 520;
            globalThis.window.getComputedStyle = () => ({
                paddingLeft: '10px',
                paddingRight: '10px',
                paddingTop: '14px',
                paddingBottom: '14px'
            });
            const origCreate = globalThis.document.createElement;
            globalThis.document.createElement = (tag) => {
                const node = origCreate(tag);
                if (tag === 'span') {
                    node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 8, height: 18 });
                }
                return node;
            };

            try {
                const sizedShell = new Shell({ cwd: '/root' });
                const term = new Terminal({
                    el,
                    cli: sizedShell
                });

                // (1020 - 20) / 8 = 125 cols; (520 - 28) / 18 = 27 rows
                expect(term.cols).toBe(125);
                expect(term.rows).toBe(27);
                expect(sizedShell.stdout.columns).toBe(125);
                expect(sizedShell.stdout.rows).toBe(27);
                expect(sizedShell.context.getVar('COLUMNS')).toBe('125');
                expect(sizedShell.context.getVar('LINES')).toBe('27');

                term.destroy();
            } finally {
                globalThis.document.createElement = origCreate;
                delete globalThis.window.getComputedStyle;
            }
        });

        it('does not double-emit Enter when mobile input keydown bubbles to window', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                mobileInput: 'click'
            });

            const received = [];
            term.onData((d) => received.push(d));

            const enterEvent = {
                key: 'Enter',
                defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; }
            };
            // Dispatch on hidden <input>, then simulate DOM bubbling to window
            term._mobileInputElement.dispatchEvent('keydown', enterEvent);
            globalThis.window.dispatchEvent('keydown', enterEvent);

            // IME composing events on window should also be ignored
            globalThis.window.dispatchEvent('keydown', { key: 'a', isComposing: true });
            globalThis.window.dispatchEvent('keydown', { key: 'a', keyCode: 229 });

            expect(received).toEqual(['\r']);
            term.destroy();
        });

        it('supports legacy/alias key names and ignores bare lock/unidentified keys', () => {
            const el = document.createElement('div');
            const term = new Terminal({
                el,
                Shell: false,
                cols: 80,
                rows: 24
            });

            const received = [];
            term.onData((d) => received.push(d));

            term.sendKey('Space');
            term.sendKey('Spacebar');
            term.sendKey('Return');
            term.sendKey('Esc');
            term.sendKey('Up');
            term.sendKey('Down');
            term.sendKey('Right');
            term.sendKey('Left');
            term.sendKey('Del');
            term.sendKey('F1');
            term.sendKey('F12');
            term.sendKey('NumLock');
            term.sendKey('ScrollLock');
            term.sendKey('CapsLock');
            term.sendKey('Dead');
            term.sendKey('Unidentified');

            expect(received).toEqual([
                ' ', ' ', '\r', '\x1b',
                '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D',
                '\x1b[3~', '\x1bOP', '\x1b[24~'
            ]);
            term.destroy();
        });

        it('passes Ctrl+C (^C) to raw ReplCommand to clear current input instead of killing REPL', async () => {
            class LineClearRepl extends Shell.ReplCommand {
                static get name() { return 'clearrepl'; }
                shouldBeInteractive() { return true; }
                getReplTitle() { return 'LineClear REPL'; }
                getReplPrompt() { return 'lc> '; }
                async evaluateReplLine(line) {
                    return { output: [`ok:${line}`] };
                }
            }

            const replShell = new Shell({ filesystem: { root: {} }, cwd: '/root', hostname: 'brsh' });
            const ready = waitForReady(replShell);
            const term = new Terminal({
                el: document.createElement('div'),
                cli: replShell,
                cols: 60,
                rows: 15
            });
            await ready;

            replShell.context.setCommand(LineClearRepl);
            const replDone = waitForReady(replShell);
            replShell.onCommand('clearrepl');
            await new Promise(r => setTimeout(r, 30));

            for (const ch of 'draft') term.sendKey(ch);
            // Send Ctrl+C while input is non-empty -> clears input line, keeps REPL alive in alt screen
            term.sendKey('c', { ctrl: true });
            await new Promise(r => setTimeout(r, 20));

            expect(term.screen.isAltScreen).toBe(true);
            expect(term.getScreenText()).toContain('lc> draft^C');

            // Exit cleanly with Ctrl+D
            term.sendKey('d', { ctrl: true });
            await replDone;
            expect(replShell.lastCode).toBe(0);
            term.destroy();
        });
    });
});


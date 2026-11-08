import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Shell from '../index.js';
import Terminal from '../lib/Terminal.js';

describe('Terminal decoupling and Shell resolution', () => {
    let originalWindow;
    let originalDocument;
    let originalShell;
    let originalGlobalShell;

    beforeAll(() => {
        originalWindow = globalThis.window;
        originalDocument = globalThis.document;
        originalShell = globalThis.Shell;
        originalGlobalShell = globalThis.shell;

        // Minimal DOM mock
        globalThis.window = {
            addEventListener: () => {},
            removeEventListener: () => {}
        };
        globalThis.document = {
            createElement: () => ({
                style: {},
                classList: { add: () => {} },
                appendChild: () => {},
                setAttribute: () => {},
                addEventListener: () => {},
                getBoundingClientRect: () => ({ width: 800, height: 600 }),
                querySelectorAll: () => []
            }),
            head: { appendChild: () => {} }
        };
    });

    afterAll(() => {
        globalThis.window = originalWindow;
        globalThis.document = originalDocument;
        globalThis.Shell = originalShell;
        globalThis.shell = originalGlobalShell;
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

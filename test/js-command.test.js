'use strict';

import { describe, it, expect } from 'vitest';
import JsCommand from '../lib/JsCommand.js';
import FileSystem from '../lib/FileSystem.js';
import LocalCommand from '../lib/local/LocalCommand.js';

describe('JsCommand (lib/JsCommand.js)', () => {
    it('returns an exported Command subclass directly', () => {
        class CustomCmd extends LocalCommand {
            static get name() { return 'custom'; }
            get name() { return 'custom'; }
            run() { this.stdOut = 'custom ran'; }
        }

        const fs = new FileSystem('/', {
            bin: {
                'custom.js': 'module.exports = class CustomCmd extends LocalCommand {}'
            }
        });

        // Mock loadModule on fs
        fs.loadModule = () => CustomCmd;

        const Loaded = JsCommand.load(fs, '/bin/custom.js');
        expect(Loaded).toBe(CustomCmd);
    });

    it('wraps an exported function or object as a generic command', () => {
        const fs = new FileSystem('/', {
            bin: {
                'tool.js': 'module.exports = function(args) { return "ok"; }'
            }
        });
        fs.loadModule = () => (args) => 'ok';

        const Loaded = JsCommand.load(fs, '/bin/tool.js');
        expect(typeof Loaded).toBe('function');
        expect(Loaded.prototype && typeof Loaded.prototype.run === 'function').toBe(true);
    });

    it('auto-wires sibling .wasm binary when wrapping a module', () => {
        const dummyWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        const fs = new FileSystem('/', {
            usr: {
                lib: {
                    mytool: {
                        'mytool.js': 'module.exports = {}',
                        'mytool.wasm': dummyWasm
                    }
                }
            }
        });
        fs.loadModule = () => ({});

        const Loaded = JsCommand.load(fs, '/usr/lib/mytool/mytool.js');
        expect(typeof Loaded).toBe('function');
        const instance = new Loaded([], { fs });
        expect(instance.requiresFilesystem).toBe(true);
    });

    it('uses the cache when content matches and invalidates when content changes', () => {
        const cache = new Map();
        const fs = new FileSystem('/', {
            bin: {
                'cached.js': 'module.exports = class V1 extends LocalCommand {}'
            }
        });

        class V1 extends LocalCommand { static get name() { return 'v1'; } }
        class V2 extends LocalCommand { static get name() { return 'v2'; } }

        fs.loadModule = (p) => V1;
        const First = JsCommand.load(fs, '/bin/cached.js', 'content1', cache);
        expect(First).toBe(V1);
        expect(cache.has('/bin/cached.js')).toBe(true);

        // Second call with same content returns cached V1 without re-evaluating
        fs.loadModule = (p) => V2;
        const Second = JsCommand.load(fs, '/bin/cached.js', 'content1', cache);
        expect(Second).toBe(V1);

        // Third call with changed content re-evaluates to V2
        const Third = JsCommand.load(fs, '/bin/cached.js', 'content2', cache);
        expect(Third).toBe(V2);
    });

    it('throws a descriptive error when script evaluation fails', () => {
        const fs = new FileSystem('/', {
            bin: {
                'broken.js': 'syntax error !!!'
            }
        });
        fs.loadModule = () => { throw new Error('Unexpected token'); };

        expect(() => {
            JsCommand.load(fs, '/bin/broken.js');
        }).toThrow(/Failed to evaluate script/);
    });

    it('detects JS files and Command classes via static helpers', () => {
        class ValidCmd extends LocalCommand {
            run() {}
        }
        function plainFn() {}

        expect(JsCommand.isCommandClass(ValidCmd)).toBe(true);
        expect(JsCommand.isCommandClass(plainFn)).toBe(false);
        expect(JsCommand.isJsFile('/bin/foo.js', 'console.log(1)')).toBe(true);
        expect(JsCommand.isJsFile('/bin/foo', 'module.exports = {}')).toBe(true);
        expect(JsCommand.isJsFile('/bin/foo', plainFn)).toBe(true);
        expect(JsCommand.isJsFile('/bin/foo', '#!/bin/sh\necho hi')).toBe(false);
    });

    it('resolves multi-hop relative and absolute symlinks via fs.realpath', () => {
        const fs = new FileSystem('/', {
            usr: { lib: { pkg: { 'tool.js': 'module.exports = {}' } } },
            bin: {}
        });
        fs.createSymlink('/usr/lib/pkg/tool.js', '/bin/tool');
        fs.createSymlink('tool', '/bin/tool-alias');

        expect(fs.realpath('/bin/tool-alias')).toBe('/usr/lib/pkg/tool.js');
    });
});

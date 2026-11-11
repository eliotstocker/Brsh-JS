import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createShell } from './helpers.js';

const DOOM_WASM_CANDIDATES = [
    path.resolve(import.meta.dirname, '../../doom-wasm/dist/doom.wasm'),
    '/home/antigravity/eliotstocker/doom-wasm/dist/doom.wasm',
    '/home/antigravity/doom-ascii/dist/doom.wasm',
    '/tmp/doom-asyncify.wasm'
];
const DOOM_WAD_CANDIDATES = [
    '/tmp/doom1.wad',
    '/tmp/freedoom1.wad'
];
const DOOM_WASM_PATH = DOOM_WASM_CANDIDATES.find(p => fs.existsSync(p)) || DOOM_WASM_CANDIDATES[0];
const DOOM_WAD_PATH = DOOM_WAD_CANDIDATES.find(p => fs.existsSync(p)) || DOOM_WAD_CANDIDATES[0];
const hasDoom = fs.existsSync(DOOM_WASM_PATH) && fs.existsSync(DOOM_WAD_PATH);
const hasDoom1Demo = fs.existsSync(DOOM_WASM_PATH) && fs.existsSync('/tmp/doom1.wad');

describe('Doom in brsh', () => {
    it.skipIf(!hasDoom1Demo)('executes doom timedemo benchmark cleanly to completion', async () => {
        const doomWasm = fs.readFileSync(DOOM_WASM_PATH);
        const doomWad = fs.readFileSync('/tmp/doom1.wad');
        const shell = await createShell({
            filesystem: {
                bin: { 'doom': doomWasm },
                game: { 'doom1.wad': doomWad }
            },
            permissions: {
                '/bin/doom': 0o755
            },
            cwd: '/game'
        });

        const lines = [];
        shell.stdout.on('data', chunk => lines.push(chunk.toString()));

        await shell.onCommand('doom -timedemo demo1 -nosound -nodraw');
        expect(shell.lastCode).toBe(0);
        const allOut = lines.join('');
        expect(allOut).toContain('DOOM ASCII');
        expect(allOut).toMatch(/timed \d+ gametics/);
    }, 30000);

    it.skipIf(!hasDoom)('exits interactive doom and freedoom cleanly on Ctrl+C (SIGINT, exit code 130)', async () => {
        const doomWasm = new Uint8Array(fs.readFileSync(DOOM_WASM_PATH));
        const doomWad = new Uint8Array(fs.readFileSync(DOOM_WAD_PATH));
        const mod = new WebAssembly.Module(doomWasm);
        expect(WebAssembly.Module.exports(mod).map(e => e.name)).toContain('get_termios_lflag');

        const shell = await createShell({
            filesystem: {
                usr: {
                    lib: {
                        doom: {
                            'doom.wasm': doomWasm,
                            'freedoom': '#!/bin/sh\ndoom -iwad /usr/share/games/doom/game.wad -nosound\n',
                            'package.json': JSON.stringify({ name: 'doom', bin: 'doom', interactive: true })
                        }
                    },
                    share: {
                        games: {
                            doom: {
                                'game.wad': doomWad
                            }
                        }
                    }
                }
            }
        });
        shell.context.fs.createSymlink('/usr/lib/doom/doom.wasm', '/bin/doom');
        shell.context.fs.setMode('/usr/lib/doom/doom.wasm', 0o755);
        shell.context.fs.createSymlink('/usr/lib/doom/freedoom', '/bin/freedoom');
        shell.context.fs.setMode('/usr/lib/doom/freedoom', 0o755);

        const chunks = [];
        const onData = chunk => chunks.push(String(chunk));
        shell.stdout.on('data', onData);

        const runPromise = shell.onCommand('freedoom');
        await new Promise(r => setTimeout(r, 350));

        expect(shell.runningCommand).toBeDefined();
        expect(shell.runningCommand.isRaw).toBe(false);
        expect(shell.runningCommand._inAltScreen).toBe(true);

        shell.write('\x03');
        await runPromise;
        shell.stdout.off('data', onData);

        const out = chunks.join('');
        expect(shell.lastCode).toBe(130);
        expect(out).toContain('\x1b[?1049h');
        expect(out).toContain('\x1b[?1049l\x1b[?25h');
        expect(out).not.toContain('^C\r\n');
    }, 30000);
});

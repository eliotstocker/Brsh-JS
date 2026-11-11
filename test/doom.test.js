import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createShell } from './helpers.js';

const DOOM_WASM_CANDIDATES = [
    '/home/antigravity/eliotstocker/doom-wasm/dist/doom.wasm',
    '/home/antigravity/doom-ascii/dist/doom.wasm',
    '/tmp/doom-asyncify.wasm'
];
const DOOM_WASM_PATH = DOOM_WASM_CANDIDATES.find(p => fs.existsSync(p)) || DOOM_WASM_CANDIDATES[0];
const DOOM_WAD_PATH = '/tmp/doom1.wad';
const hasDoom = fs.existsSync(DOOM_WASM_PATH) && fs.existsSync(DOOM_WAD_PATH);

describe('Doom in brsh', () => {
    it.skipIf(!hasDoom)('executes doom timedemo benchmark cleanly to completion', async () => {
        const doomWasm = fs.readFileSync(DOOM_WASM_PATH);
        const doomWad = fs.readFileSync(DOOM_WAD_PATH);
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
});

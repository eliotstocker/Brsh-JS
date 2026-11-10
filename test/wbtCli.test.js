'use strict';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { mkdtempSync, rmSync, existsSync, readlinkSync, readFileSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import Shell from '../index.js';
import { createShell, run } from './helpers.js';

const WBT_CLI = resolve(import.meta.dirname, '../bin/wbt.js');
const EXPORT_FS_CLI = resolve(import.meta.dirname, '../bin/exportFileSystem.js');

function runWbt(args, cwd) {
    return spawnSync(process.execPath, [WBT_CLI, ...args], {
        cwd,
        encoding: 'utf8'
    });
}

function runExportFs(args, cwd) {
    return spawnSync(process.execPath, [EXPORT_FS_CLI, ...args], {
        cwd,
        encoding: 'utf8'
    });
}

describe('Standalone wbt CLI (bin/wbt.js)', () => {
    let tmpFsRoot;
    let outDir;

    beforeEach(() => {
        tmpFsRoot = mkdtempSync(join(tmpdir(), 'brsh-wbt-cli-test-root-'));
        outDir = mkdtempSync(join(tmpdir(), 'brsh-wbt-cli-test-out-'));
    });

    afterEach(() => {
        rmSync(tmpFsRoot, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    });

    it('displays help when invoked with --help without requiring --root', () => {
        const res = runWbt(['--help']);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('wbt [options] <command> [args...]');
        expect(res.stdout).toContain('--root');
        expect(res.stdout).toContain('install');
    });

    it('displays version when invoked with --version without requiring --root', () => {
        const res = runWbt(['--version']);
        expect(res.status).toBe(0);
        expect(res.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    it('allows searching packages without requiring --root', () => {
        const res = runWbt(['search', 'editor']);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('nano');
    });

    it('allows showing package details without requiring --root', () => {
        const res = runWbt(['show', 'nano']);
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Package: nano');
        expect(res.stdout).toContain('Version: 8.0.1');
    });

    it('fails when --root is missing for mutating commands (install, remove, list, update)', () => {
        const installRes = runWbt(['install', 'nano']);
        expect(installRes.status).toBe(1);
        expect(installRes.stderr).toContain('--root <dir>');

        const removeRes = runWbt(['remove', 'nano']);
        expect(removeRes.status).toBe(1);
        expect(removeRes.stderr).toContain('--root <dir>');

        const listRes = runWbt(['list', '--installed']);
        expect(listRes.status).toBe(1);
        expect(listRes.stderr).toContain('--root <dir>');

        const updateRes = runWbt(['update']);
        expect(updateRes.status).toBe(1);
        expect(updateRes.stderr).toContain('--root <dir>');
    });

    it('fails when --root is set to system root / for safety', () => {
        const res = runWbt(['--root', '/', 'install', 'nano']);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("Refusing to operate on system root '/'");
    });

    it('fails when --root does not exist', () => {
        const nonExistent = join(tmpdir(), `non-existent-${Date.now()}`);
        const res = runWbt(['--root', nonExistent, 'install', 'nano']);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('does not exist');
    });

    it('installs a package into an explicit --root directory on the host filesystem', () => {
        const res = runWbt(['--root', tmpFsRoot, 'install', 'nano']);
        expect(res.status).toBe(0);

        // Verify /usr/lib/nano/nano.wasm and /usr/lib/nano/package.json
        const wasmPath = join(tmpFsRoot, 'usr', 'lib', 'nano', 'nano.wasm');
        const pkgJsonPath = join(tmpFsRoot, 'usr', 'lib', 'nano', 'package.json');
        expect(existsSync(wasmPath)).toBe(true);
        expect(existsSync(pkgJsonPath)).toBe(true);

        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        expect(pkgJson.name).toBe('nano');
        expect(pkgJson.version).toBe('8.0.1');

        // Verify symlinks in /bin
        const binNano = join(tmpFsRoot, 'bin', 'nano');
        const binNanoWasm = join(tmpFsRoot, 'bin', 'nano-wasm');
        expect(lstatSync(binNano).isSymbolicLink()).toBe(true);
        expect(lstatSync(binNanoWasm).isSymbolicLink()).toBe(true);

        // Symlink target is virtual path relative to container root
        expect(readlinkSync(binNano)).toBe('/usr/lib/nano/nano.wasm');
        expect(readlinkSync(binNanoWasm)).toBe('/usr/lib/nano/nano.wasm');

        // Verify installed.json was NOT created
        expect(existsSync(join(tmpFsRoot, 'var', 'lib', 'wbt', 'installed.json'))).toBe(false);

        // Verify `wbt --root <dir> list --installed` lists nano
        const listRes = runWbt(['-r', tmpFsRoot, 'list', '--installed']);
        expect(listRes.status).toBe(0);
        expect(listRes.stdout).toContain('nano');
    });

    it('pre-installs packages via wbt CLI, packages with exportFileSystem into .brfs, and boots clean Shell executing WASM without wbt', async () => {
        // 1. Install nano into tmpFsRoot using standalone wbt CLI
        const installRes = runWbt(['--root', tmpFsRoot, 'install', 'nano']);
        expect(installRes.status).toBe(0);

        // 2. Export filesystem into a standalone .brfs container
        const brfsFile = join(outDir, 'prepackaged.brfs');
        const exportRes = runExportFs([tmpFsRoot, '-o', brfsFile]);
        expect(exportRes.status).toBe(0);
        expect(existsSync(brfsFile)).toBe(true);

        // 3. Boot a Shell directly from the .brfs binary container file
        const shell = await createShell({ filesystem: brfsFile });

        // Verify wbt is NOT registered in this shell
        expect(shell.context.getCommand('wbt')).toBeNull();

        // 4. Run `nano --version` inside the clean Shell
        const res = await run(shell, 'nano --version');
        expect(res.exitCode).toBe(0);
        expect(res.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);

        // 5. Run via alias `nano-wasm --version`
        const aliasRes = await run(shell, 'nano-wasm --version');
        expect(aliasRes.exitCode).toBe(0);
        expect(aliasRes.output.join('\n')).toMatch(/GNU nano, version 8\.0|nano.*8\.0\.[0-9]+.*wasm/i);
    });
});

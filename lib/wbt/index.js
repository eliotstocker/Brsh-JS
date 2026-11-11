'use strict';

const path = require('path');
const Command = require('../Command');
const WasmCommand = require('../WasmCommand');
const ReplCommand = require('../ReplCommand');
const { DEFAULT_REGISTRY, resolvePackageName } = require('./registry');
const wllamaAdapter = require('./packages/wllama');
const { writeBytesToFs, createGenericWasmCommand } = WasmCommand;
const { createReplWasmCommand } = ReplCommand;

const CACHE_DIR = '/var/cache/wbt';
/**
 * Creates a Command class that executes a custom installed WASM or WAT file at `wasmPath`.
 */
function createCustomWasmBinCommand(binName, wasmPath, pkgMeta = {}) {
    class CustomWasmBin extends WasmCommand {
        static get name() { return binName; }
        get name() { return binName; }
        get requiresFilesystem() { return true; }

        get interactive() {
            const isHelpOrVersion = (this.arguments || []).some(a => a === '--help' || a === '-h' || a === '--version' || a === '-V' || a === '-v');
            if (isHelpOrVersion) return false;
            if (this._isInteractive !== undefined) return Boolean(this._isInteractive);
            return Boolean(pkgMeta.interactive || binName === 'nano');
        }

        get captureInput() {
            return this.interactive;
        }

        constructor(args, context) {
            super(wasmPath, args, context);
            this.script = wasmPath;
            this.arguments = args || [];
            this.context = context || null;
            if (context && context.fs && !this.fs) {
                this.fs = context.fs;
            }
            this._pkgMeta = pkgMeta;
        }
    }
    return CustomWasmBin;
}

/**
 * Web Binary Tool (wbt) — optional APT-style WASM binary manager for brsh.
 *
 * Register in a shell via:
 *   import Wbt from 'brsh/wbt';
 *   shell.context.setCommand(Wbt);
 *
 * Or configure with custom registry/options:
 *   const CustomWbt = Wbt.configure({ registry: { ... } });
 *   shell.context.setCommand(CustomWbt);
 */
class Wbt extends Command {
    static get name() { return 'wbt'; }
    get name() { return 'wbt'; }
    get requiresFilesystem() { return true; }

    get _fs() {
        return this.fs || (this.context && this.context.fs) || null;
    }

    get _pathDir() {
        return (this.context && typeof this.context.getVar === 'function' && this.context.getVar('PATH')) || '/bin';
    }

    _withWritableParent(targetPath, fn) {
        const fs = this._fs;
        if (!fs) return;
        const abs = typeof fs.absolutePath === 'function' ? fs.absolutePath(targetPath) : targetPath;
        const parts = abs.split('/');
        parts.pop();
        const parentPath = parts.join('/') || '/';
        const parentMode = typeof fs.getMode === 'function' ? fs.getMode(parentPath) : null;
        const needsChmod = parentMode !== null && (parentMode & 0o200) === 0;
        if (needsChmod) {
            try { fs.setMode(parentPath, parentMode | 0o200); } catch { /* ignore */ }
        }
        try {
            return fn(fs);
        } finally {
            if (needsChmod) {
                try { fs.setMode(parentPath, parentMode); } catch { /* ignore */ }
            }
        }
    }

    _writeFileSafe(targetPath, content) {
        this._withWritableParent(targetPath, (fs) => {
            if (fs.exists(targetPath)) {
                try { fs.setMode(targetPath, 0o755); } catch { /* ignore */ }
            }
            fs.setFileByPath(targetPath, content, true);
        });
    }

    _writeBytesSafe(targetPath, bytes, mimeType = 'application/wasm') {
        this._withWritableParent(targetPath, (fs) => {
            if (fs.exists(targetPath)) {
                try { fs.setMode(targetPath, 0o755); } catch { /* ignore */ }
            }
            writeBytesToFs(fs, targetPath, bytes, mimeType);
        });
    }

    get interactive() {
        if (this._activeSubCommand && this._activeSubCommand.interactive !== undefined) {
            return Boolean(this._activeSubCommand.interactive);
        }
        if (this.arguments && this.arguments[0] === 'run' && this.arguments[1]) {
            const resolvedName = resolvePackageName(this.arguments[1]);
            const pkgMeta = this._getRegistry()[resolvedName];
            if (pkgMeta && pkgMeta.interactive) {
                const isHelpOrVersion = this.arguments.slice(2).some(a => a === '--help' || a === '-h' || a === '--version' || a === '-V' || a === '-v');
                return !isHelpOrVersion;
            }
        }
        return false;
    }

    get captureInput() {
        if (this._activeSubCommand && this._activeSubCommand.captureInput !== undefined) {
            return Boolean(this._activeSubCommand.captureInput);
        }
        return this.interactive;
    }

    get isRaw() {
        if (this._activeSubCommand) {
            return Boolean(
                this._activeSubCommand.isRaw
                || (this._activeSubCommand.stdinStream && this._activeSubCommand.stdinStream.isRaw)
            );
        }
        return Boolean(this.stdinStream && this.stdinStream.isRaw);
    }

    get _inAltScreen() {
        return Boolean(this.__inAltScreen || (this._activeSubCommand && this._activeSubCommand._inAltScreen));
    }

    set _inAltScreen(val) {
        this.__inAltScreen = Boolean(val);
    }

    kill(signal = 'SIGINT') {
        if (this._activeSubCommand && typeof this._activeSubCommand.kill === 'function') {
            this._activeSubCommand.kill(signal);
        }
        super.kill(signal);
    }

    onInput(key) {
        if (this._activeSubCommand && typeof this._activeSubCommand.onInput === 'function') {
            this._activeSubCommand.onInput(key);
        }
    }

    static get _config() {
        return this.__wbtConfig || {};
    }

    static get _adapters() {
        if (!this.__adapters) this.__adapters = new Map();
        return this.__adapters;
    }

    static registerAdapter(name, factory) {
        this._adapters.set(name, factory);
    }

    /**
     * Returns a configured subclass of Wbt with custom options:
     * - `registry`: custom package metadata entries merged with DEFAULT_REGISTRY
     * - `moduleLoader`: async (pkgName, cdnUrl) => module (for custom CDN/offline/test injection)
     * - `fetch`: custom fetch function for downloading custom `.wasm` URLs or remote registries
     * - `sources`: array of remote registry JSON URLs to fetch on `wbt update`
     */
    static configure(config = {}) {
        class ConfiguredWbt extends Wbt {
            static get name() { return 'wbt'; }
        }
        ConfiguredWbt.__wbtConfig = Object.assign({}, this._config, config);
        return ConfiguredWbt;
    }

    /**
     * Restores any packages into the given Shell or Context.
     * Retained as a safe no-op for backward compatibility: packages are self-contained on the filesystem.
     */
    static restoreInstalled() {
        // No-op: virtual filesystem is self-contained via /usr/lib/ and /bin symlinks
    }

    _getRegistry() {
        const cfg = this.constructor._config || {};
        const base = Object.assign({}, DEFAULT_REGISTRY, cfg.registry || {});
        try {
            const fs = this._fs;
            const cachedRemote = fs ? fs.getFileByPath(`${CACHE_DIR}/remote-registry.json`) : null;
            if (typeof cachedRemote === 'string' && cachedRemote.trim()) {
                const parsed = JSON.parse(cachedRemote);
                Object.assign(base, parsed);
            }
        } catch {
            // ignore
        }
        return base;
    }

    _getInstalledPackages() {
        const pkgs = {};
        const fs = this._fs;
        if (!fs) return pkgs;
        const usrLib = fs.getFileByPath('/usr/lib');
        if (!usrLib || typeof usrLib !== 'object') {
            return pkgs;
        }
        const registry = this._getRegistry();

        for (const dirName of Object.keys(usrLib)) {
            if (dirName.startsWith('.')) continue;
            const pkgName = dirName.toLowerCase();
            const reg = registry[pkgName] || Object.values(registry).find(p => p.name === pkgName || p.bin === pkgName);
            const dirFiles = fs.getFileByPath(`/usr/lib/${dirName}`) || {};
            const files = (typeof dirFiles === 'object') ? Object.keys(dirFiles) : [];
            const wasmFile = files.find(f => f.endsWith('.wasm') || f.endsWith('.wat'));
            const wasmPath = wasmFile ? `/usr/lib/${dirName}/${wasmFile}` : (fs.exists(`/usr/lib/${dirName}/${pkgName}.wasm`) ? `/usr/lib/${dirName}/${pkgName}.wasm` : null);

            const primaryBin = (reg && reg.bin) || pkgName;
            const bins = [primaryBin];
            if (reg && reg.aliases) {
                bins.push(...reg.aliases);
            }
            if (reg && reg.scripts) {
                bins.push(...Object.keys(reg.scripts));
            }

            pkgs[pkgName] = Object.assign({
                name: pkgName,
                bin: primaryBin,
                bins,
                version: (reg && reg.version) || 'custom',
                description: (reg && reg.description) || `Installed package ${pkgName}`,
                type: (reg && reg.type) || (wasmPath ? 'custom-wasm' : 'generic-runtime'),
                wasmPath
            }, reg || {});
            if (wasmPath) {
                pkgs[pkgName].wasmPath = wasmPath;
            }
        }
        return pkgs;
    }

    _generateJsCommandSource(pkgMeta, binName) {
        if (pkgMeta.adapter === 'wllama' || pkgMeta.name === 'wllama') {
            const wllamaPath = path.resolve(__dirname, 'packages/wllama.js');
            return `'use strict';\n` +
                `let wllamaModule;\n` +
                `try {\n` +
                `    wllamaModule = require(${JSON.stringify(wllamaPath)});\n` +
                `} catch (_) {\n` +
                `    try {\n` +
                `        wllamaModule = require('brsh/wbt/packages/wllama');\n` +
                `    } catch (e) {\n` +
                `        wllamaModule = require('./wllama');\n` +
                `    }\n` +
                `}\n` +
                `module.exports = wllamaModule.createWllamaCommand(${JSON.stringify(pkgMeta)}, {}, ${JSON.stringify(binName)});\n`;
        }

        const serializedMeta = JSON.stringify(pkgMeta, null, 2);
        if (pkgMeta.repl) {
            return `'use strict';\n` +
                `const pkgMeta = ${serializedMeta};\n` +
                `const _Repl = typeof ReplCommand !== 'undefined' ? ReplCommand : (typeof require !== 'undefined' ? require('brsh/ReplCommand') : globalThis.ReplCommand);\n` +
                `module.exports = _Repl.createReplWasmCommand(pkgMeta, {}, ${JSON.stringify(binName)});\n`;
        }

        return `'use strict';\n` +
            `const pkgMeta = ${serializedMeta};\n` +
            `const _Wasm = typeof WasmCommand !== 'undefined' ? WasmCommand : (typeof require !== 'undefined' ? require('brsh/WasmCommand') : globalThis.WasmCommand);\n` +
            `module.exports = _Wasm.createGenericWasmCommand(pkgMeta, {}, ${JSON.stringify(binName)});\n`;
    }

    _buildCommandsForPackage(pkgMeta) {
        const cfg = this.constructor._config || {};

        if ((pkgMeta.type === 'custom-wasm' || pkgMeta.type === 'wasm') && pkgMeta.wasmPath) {
            const binName = (pkgMeta.bin || pkgMeta.name).toLowerCase();
            return [{ bin: binName, Cmd: createCustomWasmBinCommand(binName, pkgMeta.wasmPath, pkgMeta) }];
        }

        const adapterKey = pkgMeta.adapter || pkgMeta.name;
        let factory = this.constructor._adapters && this.constructor._adapters.get(adapterKey);
        if (!factory && adapterKey === 'wllama') {
            factory = wllamaAdapter.buildEntries || wllamaAdapter.createAdapter || wllamaAdapter;
        }
        if (!factory && pkgMeta.adapter) {
            try {
                const adapterMod = require(`./packages/${pkgMeta.adapter}`);
                factory = adapterMod.buildEntries || adapterMod.createAdapter || adapterMod;
            } catch {}
        }
        if (typeof factory === 'function') {
            const result = factory(pkgMeta, cfg);
            if (Array.isArray(result)) return result;
            if (result) return [{ bin: (pkgMeta.bin || pkgMeta.name).toLowerCase(), Cmd: result }];
        }

        // Use `createReplWasmCommand` for packages with REPL enabled (`repl: true`),
        // and standard `createGenericWasmCommand` for non-interactive WASM CLI binaries.
        const cmdBuilder = pkgMeta.repl ? createReplWasmCommand : createGenericWasmCommand;
        const binName = (pkgMeta.bin || pkgMeta.name.split('/').pop()).toLowerCase();
        const entries = [{ bin: binName, Cmd: cmdBuilder(pkgMeta, cfg, binName) }];
        for (const alias of (pkgMeta.aliases || [])) {
            const aliasLower = alias.toLowerCase();
            if (aliasLower !== binName) {
                entries.push({ bin: aliasLower, Cmd: cmdBuilder(pkgMeta, cfg, aliasLower) });
            }
        }
        return entries;
    }

    _registerPackageIntoContext(pkgMeta) {
        const fs = this._fs;
        const cfg = this.constructor._config || {};
        const pathDir = this._pathDir;
        const pkgName = (pkgMeta.name || '').split('/').pop().toLowerCase();
        const primaryBin = (pkgMeta.bin || pkgName).toLowerCase();
        const targetDir = `/usr/lib/${pkgName}`;
        const entries = this._buildCommandsForPackage(pkgMeta);
        const installedBins = [];
        const adapterKey = pkgMeta.adapter || pkgMeta.name;
        const hasRuntimeClosure = Boolean(
            cfg.moduleLoader
            || cfg.fetch
            || adapterKey === 'wllama'
            || (this.constructor._adapters && this.constructor._adapters.has(adapterKey))
        );

        // Check if pure wasm exists at targetDir
        const wasmPath = pkgMeta.wasmPath || (fs.exists(`${targetDir}/${primaryBin}.wasm`) ? `${targetDir}/${primaryBin}.wasm` : null);

        const metaPath = `${targetDir}/package.json`;
        const pkgInfo = {
            name: pkgMeta.name,
            version: pkgMeta.version || '1.0.0',
            bin: primaryBin,
            aliases: pkgMeta.aliases || [],
            description: pkgMeta.description || '',
            ...(pkgMeta.interactive ? { interactive: true } : {})
        };
        this._writeFileSafe(metaPath, JSON.stringify(pkgInfo, null, 2));

        for (const { bin, Cmd } of entries) {
            const binName = bin.toLowerCase();
            let targetFile;

            if (wasmPath && (!pkgMeta.type || pkgMeta.type === 'custom-wasm' || pkgMeta.type === 'wasm')) {
                targetFile = wasmPath;
            } else {
                targetFile = `${targetDir}/${binName}.js`;
                const jsSource = this._generateJsCommandSource(pkgMeta, binName);
                if (typeof Cmd === 'function') {
                    Cmd.__source = jsSource;
                }
                if (!fs.isRealFilesystem && typeof Cmd === 'function' && hasRuntimeClosure) {
                    this._writeFileSafe(targetFile, Cmd);
                } else {
                    this._writeFileSafe(targetFile, jsSource);
                }
                try { fs.setMode(targetFile, 0o755); } catch { /* ignore */ }
            }

            this._createBinSymlink(pathDir, binName, targetFile);
            installedBins.push(binName);
        }

        for (const alias of (pkgMeta.aliases || [])) {
            const aliasLower = alias.toLowerCase();
            if (!installedBins.includes(aliasLower) && entries.length > 0) {
                const primaryTarget = wasmPath && (!pkgMeta.type || pkgMeta.type === 'custom-wasm' || pkgMeta.type === 'wasm')
                    ? wasmPath
                    : `${targetDir}/${primaryBin}.js`;
                this._createBinSymlink(pathDir, aliasLower, primaryTarget);
                installedBins.push(aliasLower);
            }
        }

        const scriptMap = pkgMeta.scriptPaths || {};
        for (const [scriptBin, scriptTarget] of Object.entries(scriptMap)) {
            const binLower = scriptBin.toLowerCase();
            if (!installedBins.includes(binLower) && fs.exists(scriptTarget)) {
                this._createBinSymlink(pathDir, binLower, scriptTarget);
                installedBins.push(binLower);
            }
        }
        if (pkgMeta.scripts && typeof pkgMeta.scripts === 'object') {
            for (const scriptBin of Object.keys(pkgMeta.scripts)) {
                const binLower = scriptBin.toLowerCase();
                const fallbackTarget = `${targetDir}/${binLower}`;
                if (!installedBins.includes(binLower) && fs.exists(fallbackTarget)) {
                    this._createBinSymlink(pathDir, binLower, fallbackTarget);
                    installedBins.push(binLower);
                }
            }
        }

        return installedBins;
    }

    _createBinSymlink(pathDir, binName, targetFile) {
        const fs = this._fs;
        const symlinkPath = `${pathDir}/${binName.toLowerCase()}`;
        this._removeBin(pathDir, binName);
        try {
            fs.createSymlink(targetFile, symlinkPath);
            fs.setMode(symlinkPath, 0o755);
        } catch {
            this._writeFileSafe(symlinkPath, fs.getFileByPath(targetFile));
            try { fs.setMode(symlinkPath, 0o755); } catch { /* ignore */ }
        }
    }

    _removeBin(pathDir, binName) {
        const location = `${pathDir}/${binName.toLowerCase()}`;
        this._withWritableParent(location, (fs) => {
            try { fs.deleteFileByPath(location); } catch { /* ignore */ }
        });
    }

    async run() {
        const args = [...(this.arguments || [])];
        const isRunSubcmd = args.length >= 2 && args[0].toLowerCase() === 'run';
        if (args.length === 0 || (!isRunSubcmd && (args.includes('--help') || args.includes('-h') || args[0] === 'help'))) {
            this._printHelp();
            return;
        }

        if (!isRunSubcmd && (args.includes('--version') || args.includes('-v'))) {
            this.stdOut = 'wbt 1.1.0 (Web Binary Tool for brsh)';
            return;
        }

        const subcmd = args.shift().toLowerCase();

        switch (subcmd) {
            case 'install':
            case 'add':
                await this._handleInstall(args);
                break;
            case 'remove':
            case 'uninstall':
            case 'purge':
                await this._handleRemove(args);
                break;
            case 'list':
                this._handleList(args);
                break;
            case 'search':
                this._handleSearch(args);
                break;
            case 'show':
            case 'info':
                this._handleShow(args);
                break;
            case 'update':
                await this._handleUpdate(args);
                break;
            case 'run':
                await this._handleRun(args);
                break;
            default:
                this.stdErr = `E: Invalid operation ${subcmd}`;
                this.stdErr = `Run 'wbt --help' for usage information.`;
                this.exitCode = 100;
        }
    }

    async _handleInstall(args) {
        const flags = [];
        const positional = [];
        let asName = null;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === '--as' && i + 1 < args.length) {
                asName = args[++i];
            } else if (a.startsWith('--as=')) {
                asName = a.slice(5);
            } else if (a.startsWith('-')) {
                flags.push(a);
            } else {
                positional.push(a);
            }
        }
        const quiet = flags.includes('-q') || flags.includes('--quiet');
        const forceGeneric = flags.includes('--generic') || flags.includes('--npm');

        if (positional.length === 0) {
            this.stdErr = 'E: Specify at least one package to install';
            this.exitCode = 1;
            return;
        }

        const isUrl = (s) => /^(https?:\/\/|data:)/i.test(s);
        const deriveUrlBinName = (url) => (
            url.startsWith('data:')
                ? 'custom-wasm'
                : (url.split('/').pop().split('?')[0].replace(/\.(wasm|wat|mjs|js)$/i, '') || 'custom-wasm')
        );

        const registry = this._getRegistry();
        const installed = this._getInstalledPackages();
        let printedHeader = false;

        for (let i = 0; i < positional.length; i++) {
            const rawName = positional[i];

            // Case A: `<name> <url>` pair (current token is not a URL, next token is a URL)
            if (!isUrl(rawName) && i + 1 < positional.length && isUrl(positional[i + 1])) {
                const url = positional[++i];
                const pkgName = (asName || rawName).toLowerCase();
                await this._installCustomUrl(pkgName, url, quiet);
                if (this.exitCode) return;
                continue;
            }

            // Case B: standalone `<url>` (with optional `--as <name>`)
            if (isUrl(rawName)) {
                const url = rawName;
                const pkgName = (asName || deriveUrlBinName(url)).toLowerCase();
                await this._installCustomUrl(pkgName, url, quiet);
                if (this.exitCode) return;
                continue;
            }

            // Case C: registry package or `npm:<pkg>` / `esm:<pkg>`
            if (!quiet && !printedHeader) {
                this.stdOut = 'Reading package lists... Done';
                this.stdOut = 'Building dependency tree... Done';
                this.flush();
                printedHeader = true;
            }

            const pkgName = resolvePackageName(rawName);
            let pkgMeta = registry[pkgName];

            // Generic npm/esm.sh resolution when `--npm` / `--generic` or `npm:<pkg>` is used
            if (!pkgMeta && (forceGeneric || rawName.startsWith('npm:') || rawName.startsWith('esm:'))) {
                const cleanSpec = rawName.replace(/^(npm|esm):/i, '');
                const shortBin = (asName || cleanSpec.replace(/^@[^/]+\//, '').split('@')[0]).toLowerCase();
                pkgMeta = {
                    name: shortBin,
                    bin: shortBin,
                    version: 'latest',
                    description: `Dynamic WASM/ESM package from https://esm.sh/${cleanSpec}`,
                    cdnUrl: `https://esm.sh/${cleanSpec}`,
                    type: 'generic-runtime'
                };
            }

            if (!pkgMeta) {
                this.stdErr = `E: Unable to locate package ${rawName}`;
                this.exitCode = 100;
                return;
            }

            if (installed[pkgMeta.name] && !flags.includes('--reinstall') && !flags.includes('-f')) {
                if (!quiet) {
                    this.stdOut = `${pkgMeta.name} is already the newest version (${pkgMeta.version}).`;
                }
                continue;
            }

            if (!quiet) {
                this.stdOut = `Get:1 ${pkgMeta.wasmUrl || pkgMeta.cdnUrl} ${pkgMeta.name} ${pkgMeta.version} [${pkgMeta.size || 'WASM'}]`;
                this.flush();
            }

            let wasmPath = null;
            let scriptPaths = null;
            try {
                wasmPath = await this._pullPackageWasm(pkgMeta, quiet, flags.includes('--preload'));
                scriptPaths = await this._pullPackageScripts(pkgMeta, quiet);
            } catch (err) {
                this.stdErr = `E: Failed to fetch ${pkgMeta.name}: ${err.message || err}`;
                this.exitCode = 1;
                return;
            }

            if (!quiet) {
                this.stdOut = `Unpacking ${pkgMeta.name} (${pkgMeta.version})${wasmPath ? ` -> ${wasmPath}` : ''} ...`;
                this.flush();
            }

            const resolvedMeta = Object.assign(
                {},
                pkgMeta,
                wasmPath ? { wasmPath } : {},
                scriptPaths ? { scriptPaths } : {}
            );
            const bins = this._registerPackageIntoContext(resolvedMeta);

            if (!quiet) {
                this.stdOut = `Setting up ${pkgMeta.name} (${pkgMeta.version}) -> /bin/${bins.join(', /bin/')} ...`;
            }
        }
    }

    async _pullPackageScripts(pkgMeta, quiet = false, targetDir = null) {
        if (!pkgMeta || !pkgMeta.scripts || typeof pkgMeta.scripts !== 'object') {
            return null;
        }
        const cfg = this.constructor._config || {};
        const fetchFn = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
        if (!fetchFn) return null;

        const pkgName = (pkgMeta.name || '').split('/').pop().toLowerCase();
        const destDir = targetDir || `/usr/lib/${pkgName}`;
        const installed = {};

        for (const [scriptName, scriptUrl] of Object.entries(pkgMeta.scripts)) {
            if (!scriptUrl) continue;
            const binLower = scriptName.toLowerCase();
            const res = await fetchFn(scriptUrl);
            if (!res || !res.ok) {
                throw new Error(`HTTP ${res ? res.status : 'error'} fetching script ${scriptUrl}`);
            }
            let text;
            if (typeof res.text === 'function') {
                text = await res.text();
            } else if (typeof res.arrayBuffer === 'function') {
                text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
            } else {
                text = '';
            }
            const targetPath = `${destDir}/${binLower}`;
            this._writeFileSafe(targetPath, text);
            try { this._fs.setMode(targetPath, 0o755); } catch { /* ignore */ }
            installed[binLower] = targetPath;
        }

        return Object.keys(installed).length > 0 ? installed : null;
    }

    async _readResponseBytes(res, label, quiet = false) {
        const total = (res.headers && typeof res.headers.get === 'function')
            ? Number(res.headers.get('content-length') || 0)
            : 0;
        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            const chunks = [];
            let loaded = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.byteLength;
                if (!quiet && total > 0) {
                    const pct = Math.min(100, Math.round((loaded / total) * 100));
                    const filled = Math.round((pct / 100) * 20);
                    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 20 - filled));
                    this.stdOut = `\rDownloading ${label}: [${bar}] ${String(pct).padStart(3)}%`;
                    this.flush();
                }
            }
            const merged = new Uint8Array(loaded);
            let offset = 0;
            for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return merged;
        }
        if (typeof res.arrayBuffer === 'function') {
            const ab = await res.arrayBuffer();
            return new Uint8Array(ab);
        }
        return null;
    }

    _extractEmbeddedWasmFromText(text) {
        if (!text || typeof text !== 'string') return null;
        // Every base64-encoded WebAssembly binary (\0asm\x01\x00\x00\x00) starts with "AGFzbQE"
        const match = text.match(/AGFzbQE[A-Za-z0-9+/=]{32,}/);
        if (!match) return null;
        const b64 = match[0];
        try {
            if (typeof Buffer !== 'undefined') {
                return new Uint8Array(Buffer.from(b64, 'base64'));
            }
            const bin = atob(b64);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        } catch {
            return null;
        }
    }

    _extractNpmSpec(pkgMeta) {
        for (const u of [pkgMeta.cdnUrl, pkgMeta.wasmUrl]) {
            if (!u) continue;
            const jsd = u.match(/^https?:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/i);
            if (jsd) return jsd[1];
            const esm = u.match(/^https?:\/\/esm\.sh\/((?:@[^/]+\/)?[^/?#]+)(?:\/|\?|$)/i);
            if (esm) return esm[1];
            const unpkg = u.match(/^https?:\/\/unpkg\.com\/((?:@[^/]+\/)?[^/]+)(?:\/|$)/i);
            if (unpkg) return unpkg[1];
        }
        return null;
    }

    async _discoverWasmFromJsDelivr(npmSpec, pkgName, fetchFn, quiet = false) {
        if (!npmSpec || !fetchFn) return null;
        const stripVersion = (s) => s.replace(/(^@[^/]+\/[^@]+|^[^@]+)@.*$/, '$1');
        let resolvedSpec = npmSpec;
        let flatData = null;

        try {
            let res = await fetchFn(`https://data.jsdelivr.com/v1/package/npm/${resolvedSpec}/flat`);
            if ((!res || !res.ok) && resolvedSpec.includes('@')) {
                const pkgOnly = stripVersion(resolvedSpec);
                const metaRes = await fetchFn(`https://data.jsdelivr.com/v1/package/npm/${pkgOnly}`);
                if (metaRes && metaRes.ok && typeof metaRes.json === 'function') {
                    const metaJson = await metaRes.json();
                    const latest = metaJson && metaJson.tags && metaJson.tags.latest;
                    if (latest) {
                        resolvedSpec = `${pkgOnly}@${latest}`;
                        res = await fetchFn(`https://data.jsdelivr.com/v1/package/npm/${resolvedSpec}/flat`);
                    }
                }
            }
            if (res && res.ok && typeof res.json === 'function') {
                flatData = await res.json();
            }
        } catch {
            return null;
        }

        const files = (flatData && Array.isArray(flatData.files)) ? flatData.files : [];
        const wasmFiles = files.filter(f => f && typeof f.name === 'string' && /\.wasm$/i.test(f.name));
        if (wasmFiles.length > 0) {
            // Prefer non-simd/single-thread/mvp or shortest path .wasm
            wasmFiles.sort((a, b) => a.name.length - b.name.length);
            const chosen = wasmFiles[0];
            const candidateUrl = `https://cdn.jsdelivr.net/npm/${resolvedSpec}${chosen.name}`;
            try {
                const wasmRes = await fetchFn(candidateUrl);
                if (wasmRes && wasmRes.ok) {
                    const bytes = await this._readResponseBytes(wasmRes, `${pkgName}.wasm`, quiet);
                    if (bytes && bytes.byteLength > 0) {
                        return { bytes, url: candidateUrl };
                    }
                }
            } catch { /* fall through */ }
        }

        // Fallback: check JS files in the package for embedded single-file base64 WASM ("AGFzbQE...")
        const jsFiles = files.filter(f => f && typeof f.name === 'string' && /\.(?:mjs|cjs|js)$/i.test(f.name) && !/\.min\.js$/i.test(f.name));
        for (const jf of jsFiles.slice(0, 4)) {
            const jsUrl = `https://cdn.jsdelivr.net/npm/${resolvedSpec}${jf.name}`;
            try {
                const jsRes = await fetchFn(jsUrl);
                if (jsRes && jsRes.ok && typeof jsRes.text === 'function') {
                    const text = await jsRes.text();
                    const embedded = this._extractEmbeddedWasmFromText(text);
                    if (embedded) {
                        return { bytes: embedded, url: jsUrl };
                    }
                }
            } catch { /* ignore */ }
        }

        return null;
    }

    async _pullPackageWasm(pkgMeta, quiet = false, requireModuleLoad = false, targetDir = null) {
        const cfg = this.constructor._config || {};
        const fetchFn = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
        const { loadModule } = require('./utils');

        let wasmBytes = null;
        let fetchError = null;
        const wasmUrl = pkgMeta.wasmUrl || (/\.(wasm|wat)(\?.*)?$/i.test(pkgMeta.cdnUrl || '') ? pkgMeta.cdnUrl : null);

        if (wasmUrl && fetchFn) {
            try {
                const res = await fetchFn(wasmUrl);
                if (res && res.ok) {
                    wasmBytes = await this._readResponseBytes(res, `${pkgMeta.name}.wasm`, quiet);
                } else {
                    fetchError = new Error(`HTTP ${res ? res.status : 'error'} fetching ${wasmUrl}`);
                }
            } catch (err) {
                fetchError = err;
            }
        }

        // Auto-discover .wasm file or embedded base64 WASM from jsDelivr package index if direct wasmUrl was missing or 404'd
        if (!wasmBytes && fetchFn && !cfg.moduleLoader) {
            const npmSpec = this._extractNpmSpec(pkgMeta);
            if (npmSpec) {
                const discovered = await this._discoverWasmFromJsDelivr(npmSpec, pkgMeta.name, fetchFn, quiet);
                if (discovered && discovered.bytes) {
                    wasmBytes = discovered.bytes;
                    pkgMeta.wasmUrl = discovered.url;
                    fetchError = null;
                }
            }
        }

        let loadedMod = null;
        let loadModError = null;
        if (pkgMeta.cdnUrl || cfg.moduleLoader) {
            const origFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
            if (origFetch && wasmBytes && wasmBytes.byteLength > 0 && typeof Response !== 'undefined') {
                globalThis.fetch = async (input, init) => {
                    const reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
                    if (reqUrl && (!/^https?:\/\//i.test(reqUrl) && /\.wasm(\?.*)?$/i.test(reqUrl))) {
                        return new Response(wasmBytes, {
                            status: 200,
                            headers: { 'Content-Type': 'application/wasm' }
                        });
                    }
                    return origFetch(input, init);
                };
            }
            try {
                loadedMod = await loadModule(pkgMeta.name, pkgMeta.cdnUrl, cfg.moduleLoader);
            } catch (err) {
                loadModError = err;
                if (requireModuleLoad) {
                    throw err;
                }
            } finally {
                if (origFetch) globalThis.fetch = origFetch;
            }
        }

        if (!wasmBytes && loadedMod) {
            const target = loadedMod.default !== undefined ? loadedMod.default : loadedMod;
            if (target instanceof Uint8Array) {
                wasmBytes = target;
            } else if (target instanceof ArrayBuffer) {
                wasmBytes = new Uint8Array(target);
            } else if (target && (target.wasmBytes instanceof Uint8Array || target.wasm instanceof Uint8Array || target.wasmBinary instanceof Uint8Array)) {
                wasmBytes = target.wasmBytes || target.wasm || target.wasmBinary;
            }
        }

        // Last-resort check for embedded base64 WASM inside pkgMeta.cdnUrl text
        if (!wasmBytes && pkgMeta.cdnUrl && fetchFn && !cfg.moduleLoader) {
            try {
                const cdnRes = await fetchFn(pkgMeta.cdnUrl);
                if (cdnRes && cdnRes.ok && typeof cdnRes.text === 'function') {
                    const text = await cdnRes.text();
                    wasmBytes = this._extractEmbeddedWasmFromText(text);
                }
            } catch { /* ignore */ }
        }

        if (!wasmBytes && typeof cfg.moduleLoader === 'function') {
            wasmBytes = new Uint8Array([
                0x00, 0x61, 0x73, 0x6d,
                0x01, 0x00, 0x00, 0x00,
                0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
                0x03, 0x02, 0x01, 0x00,
                0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
                0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b
            ]);
        }

        if (!wasmBytes && !loadedMod && (fetchError || loadModError) && !cfg.moduleLoader) {
            throw (fetchError || loadModError);
        }

        if (wasmBytes) {
            const pkgName = (pkgMeta.name || '').split('/').pop().toLowerCase();
            const binName = (pkgMeta.bin || pkgName).toLowerCase();
            const destDir = targetDir || `/usr/lib/${pkgName}`;
            const targetPath = `${destDir}/${binName}.wasm`;
            this._writeBytesSafe(targetPath, wasmBytes, 'application/wasm');
            try { this._fs.setMode(targetPath, 0o755); } catch { /* ignore */ }
            return targetPath;
        }

        return null;
    }

    async _installCustomUrl(pkgName, url, quiet = false) {
        // If URL is an ESM JS module (.mjs / .js or esm.sh URL without .wasm/.wat), wrap with GenericWasmCommand
        const isBinaryWasmOrWat = /\.(wasm|wat)(\?.*)?$/i.test(url);
        if (!isBinaryWasmOrWat && (/^https?:\/\/esm\.sh\//i.test(url) || /\.(mjs|js)(\?.*)?$/i.test(url))) {
            const pkgMeta = {
                name: pkgName,
                bin: pkgName,
                bins: [pkgName],
                version: 'custom-esm',
                description: `Custom ESM/WASM module from ${url}`,
                cdnUrl: url,
                type: 'generic-runtime',
                installedAt: new Date().toISOString()
            };
            const wasmPath = await this._pullPackageWasm(pkgMeta, quiet, false);
            if (wasmPath) pkgMeta.wasmPath = wasmPath;
            this._registerPackageIntoContext(pkgMeta);
            if (!quiet) {
                this.stdOut = `Setting up ${pkgName} (generic runtime) -> /bin/${pkgName} ...`;
            }
            return;
        }

        const cfg = this.constructor._config || {};
        const fetchFn = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
        if (!fetchFn) {
            this.stdErr = `E: fetch is not available in this environment`;
            this.exitCode = 1;
            return;
        }

        if (!quiet) {
            this.stdOut = `Get:1 ${url} ${pkgName}`;
            this.flush();
        }

        // Rewrite github.com blob/raw URLs to raw.githubusercontent.com (which serves CORS headers)
        const normalizedUrl = url.replace(
            /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/i,
            'https://raw.githubusercontent.com/$1/$2/$3/$4'
        );

        let res;
        try {
            res = await fetchFn(normalizedUrl);
        } catch (err) {
            if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(normalizedUrl)) {
                try {
                    res = await fetchFn(`https://corsproxy.io/?${encodeURIComponent(normalizedUrl)}`);
                } catch (_proxyErr) {
                    this.stdErr = `E: Failed to fetch ${url} (GitHub Releases blocks browser CORS requests; host the .wasm on jsDelivr/unpkg/raw.githubusercontent.com): ${err.message || err}`;
                    this.exitCode = 1;
                    return;
                }
            } else {
                this.stdErr = `E: Failed to fetch ${url}: ${err.message || err}`;
                this.exitCode = 1;
                return;
            }
        }

        if (!res || !res.ok) {
            this.stdErr = `E: HTTP ${res ? res.status : 'error'} fetching ${url}`;
            this.exitCode = 1;
            return;
        }

        const isWat = url.endsWith('.wat');
        const ext = isWat ? '.wat' : '.wasm';
        const targetDir = `/usr/lib/${pkgName}`;
        const wasmPath = `${targetDir}/${pkgName}${ext}`;

        if (isWat) {
            const text = await res.text();
            this._writeFileSafe(wasmPath, text);
        } else {
            const ab = await res.arrayBuffer();
            this._writeBytesSafe(wasmPath, new Uint8Array(ab), 'application/wasm');
        }
        try { this._fs.setMode(wasmPath, 0o755); } catch { /* ignore */ }

        const pkgMeta = {
            name: pkgName,
            bin: pkgName,
            bins: [pkgName],
            version: 'custom',
            description: `Custom WebAssembly binary from ${url}`,
            cdnUrl: url,
            type: 'custom-wasm',
            wasmPath,
            installedAt: new Date().toISOString()
        };

        this._registerPackageIntoContext(pkgMeta);

        if (!quiet) {
            this.stdOut = `Setting up ${pkgName} (custom) -> /bin/${pkgName} ...`;
        }
    }

    async _handleRemove(args) {
        const positional = args.filter(a => !a.startsWith('-'));
        if (positional.length === 0) {
            this.stdErr = 'E: Specify at least one package to remove';
            this.exitCode = 1;
            return;
        }

        const installed = this._getInstalledPackages();
        const registry = this._getRegistry();
        const pathDir = this._pathDir;

        for (const rawName of positional) {
            const pkgName = resolvePackageName(rawName);
            const record = installed[pkgName] || installed[rawName.toLowerCase()];

            if (!record) {
                this.stdErr = `E: Package '${rawName}' is not installed, so not removed`;
                this.exitCode = 1;
                return;
            }

            const reg = registry[pkgName] || {};
            const binsToRemove = new Set([
                record.bin || record.name,
                ...(record.aliases || []),
                ...(reg.aliases || []),
                rawName.toLowerCase(),
                pkgName
            ]);
            if (record.scripts) {
                for (const scriptKey of Object.keys(record.scripts)) {
                    binsToRemove.add(scriptKey);
                }
            }

            for (const b of binsToRemove) {
                this._removeBin(pathDir, b);
            }

            // Remove /usr/lib/<pkgName>
            const pkgDir = `/usr/lib/${pkgName}`;
            try { this._fs.deleteFileByPath(pkgDir); } catch { /* ignore */ }

            this.stdOut = `Removing ${record.name} (${record.version}) ...`;
        }
    }

    _handleList(args) {
        const installedOnly = args.includes('--installed') || args.includes('-i');
        const registry = this._getRegistry();
        const installed = this._getInstalledPackages();

        this.stdOut = 'Listing...';

        const names = installedOnly
            ? Object.keys(installed).sort()
            : Array.from(new Set([...Object.keys(registry), ...Object.keys(installed)])).sort();

        for (const name of names) {
            const reg = registry[name];
            const inst = installed[name];
            const meta = inst || reg;
            if (!meta) continue;

            const statusTag = inst ? '[installed]' : '[available]';
            const binLabel = meta.bin && meta.bin !== meta.name ? ` (bin: ${meta.bin})` : '';
            this.stdOut = `${meta.name}/wasm ${meta.version} wasm ${statusTag}${binLabel} - ${meta.description || ''}`;
        }
    }

    _handleSearch(args) {
        const query = args.filter(a => !a.startsWith('-')).join(' ').toLowerCase();
        const registry = this._getRegistry();
        const installed = this._getInstalledPackages();

        this.stdOut = 'Sorting... Done';
        this.stdOut = 'Full Text Search... Done';

        const entries = Object.values(registry).filter(pkg => {
            if (!query) return true;
            return (
                pkg.name.toLowerCase().includes(query) ||
                (pkg.bin && pkg.bin.toLowerCase().includes(query)) ||
                (pkg.aliases && pkg.aliases.some(a => a.toLowerCase().includes(query))) ||
                (pkg.scripts && Object.keys(pkg.scripts).some(s => s.toLowerCase().includes(query))) ||
                (pkg.description && pkg.description.toLowerCase().includes(query)) ||
                (pkg.details && pkg.details.toLowerCase().includes(query))
            );
        });

        for (const pkg of entries) {
            const inst = installed[pkg.name] ? ' [installed]' : '';
            this.stdOut = `${pkg.name}/wasm ${pkg.version} wasm${inst}`;
            this.stdOut = `  ${pkg.description}`;
        }
    }

    _handleShow(args) {
        const rawName = args.find(a => !a.startsWith('-'));
        if (!rawName) {
            this.stdErr = 'E: No packages found — specify a package name';
            this.exitCode = 1;
            return;
        }

        const pkgName = resolvePackageName(rawName);
        const registry = this._getRegistry();
        const installed = this._getInstalledPackages();
        const meta = installed[pkgName] || registry[pkgName];

        if (!meta) {
            this.stdErr = `E: No packages found matching ${rawName}`;
            this.exitCode = 100;
            return;
        }

        const full = Object.assign({}, registry[pkgName] || {}, meta);
        const isInstalled = Boolean(installed[full.name]);

        this.stdOut = `Package: ${full.name}`;
        this.stdOut = `Version: ${full.version}`;
        this.stdOut = `State: ${isInstalled ? 'installed' : 'not installed'}`;
        this.stdOut = `Binary: ${full.bin || full.name}`;
        if (full.aliases && full.aliases.length > 0) {
            this.stdOut = `Aliases: ${full.aliases.join(', ')}`;
        }
        if (full.scripts && Object.keys(full.scripts).length > 0) {
            this.stdOut = `Scripts: ${Object.keys(full.scripts).join(', ')}`;
        }
        if (full.size) {
            this.stdOut = `Download-Size: ${full.size}`;
        }
        if (full.cdnUrl) {
            this.stdOut = `APT-Sources: ${full.cdnUrl}`;
        }
        if (full.wasmUrl) {
            this.stdOut = `WASM-URL: ${full.wasmUrl}`;
        }
        if (full.wasmPath) {
            this.stdOut = `WASM-File: ${full.wasmPath}`;
        }
        if (full.homepage) {
            this.stdOut = `Homepage: ${full.homepage}`;
        }
        this.stdOut = `Description: ${full.description || ''}`;
        if (full.details) {
            this.stdOut = ` ${full.details}`;
        }
    }

    async _handleUpdate() {
        const cfg = this.constructor._config || {};
        const sources = cfg.sources || [];
        const fetchFn = cfg.fetch || (typeof fetch === 'function' ? fetch : null);

        const mergedRemote = {};
        let idx = 1;
        this.stdOut = 'Hit:1 https://registry.brsh.dev/wbt wasm InRelease';

        for (const srcUrl of sources) {
            idx++;
            if (!fetchFn) continue;
            try {
                const res = await fetchFn(srcUrl);
                if (res && res.ok) {
                    const data = await res.json();
                    Object.assign(mergedRemote, data);
                    this.stdOut = `Get:${idx} ${srcUrl} Packages`;
                }
            } catch (err) {
                this.stdErr = `W: Failed to fetch ${srcUrl}: ${err.message || err}`;
            }
        }

        if (Object.keys(mergedRemote).length > 0) {
            this._writeFileSafe(`${CACHE_DIR}/remote-registry.json`, JSON.stringify(mergedRemote, null, 2));
        }

        const registry = this._getRegistry();
        this.stdOut = `Reading package lists... Done (${Object.keys(registry).length} packages available)`;
    }

    async _handleRun(args) {
        if (args.length === 0) {
            this.stdErr = 'E: Specify a package to run (e.g. wbt run sqlite3 --version)';
            this.exitCode = 1;
            return;
        }
        const rawName = args.shift();
        const pkgName = resolvePackageName(rawName);
        const registry = this._getRegistry();
        const installed = this._getInstalledPackages();
        const isInstalled = Boolean(installed[pkgName]);
        let pkgMeta = installed[pkgName] || registry[pkgName];

        if (!pkgMeta && (rawName.startsWith('npm:') || rawName.startsWith('esm:'))) {
            const cleanSpec = rawName.replace(/^(npm|esm):/i, '');
            const shortBin = cleanSpec.replace(/^@[^/]+\//, '').split('@')[0].toLowerCase();
            pkgMeta = {
                name: shortBin,
                bin: shortBin,
                version: 'latest',
                cdnUrl: `https://esm.sh/${cleanSpec}`,
                type: 'generic-runtime'
            };
        }

        if (!pkgMeta) {
            this.stdErr = `E: Unable to locate package ${rawName}`;
            this.exitCode = 100;
            return;
        }

        const fs = this._fs;
        let tempDir = null;
        const origPath = this._pathDir;
        try {
            if (!isInstalled) {
                tempDir = `/tmp/.wbt-run-${pkgName}-${Date.now()}`;
            }

            if ((pkgMeta.type === 'custom-wasm' || pkgMeta.type === 'wasm') && !pkgMeta.wasmPath) {
                try {
                    const wasmPath = await this._pullPackageWasm(pkgMeta, true, false, tempDir);
                    if (wasmPath) {
                        pkgMeta = Object.assign({}, pkgMeta, { wasmPath });
                    }
                } catch (err) {
                    this.stdErr = `E: Failed to fetch ${pkgMeta.name}: ${err.message || err}`;
                    this.exitCode = 1;
                    return;
                }
            }

            const rawLower = rawName.toLowerCase();
            let instance;
            if (pkgMeta.scripts && pkgMeta.scripts[rawLower]) {
                let scriptPath = (pkgMeta.scriptPaths && pkgMeta.scriptPaths[rawLower]) || `/usr/lib/${pkgName}/${rawLower}`;
                if (!fs.exists(scriptPath)) {
                    try {
                        const pulledScripts = await this._pullPackageScripts(pkgMeta, true, tempDir);
                        if (pulledScripts && pulledScripts[rawLower]) {
                            scriptPath = pulledScripts[rawLower];
                        }
                    } catch (err) {
                        this.stdErr = `E: Failed to fetch script ${rawLower}: ${err.message || err}`;
                        this.exitCode = 1;
                        return;
                    }
                }
                const getCtxVar = (v) => (this.context && typeof this.context.getVar === 'function') ? this.context.getVar(v) : '';
                const effectivePath = tempDir ? `${tempDir}:${origPath}` : origPath;
                const baseVars = (this.context && this.context.vars) ? Object.assign({}, this.context.vars) : {
                    HOME: getCtxVar('HOME') || '/root',
                    HOST: getCtxVar('HOST') || 'browser',
                    COLUMNS: String((this.stdout && this.stdout.columns) || getCtxVar('COLUMNS') || 80),
                    LINES: String((this.stdout && this.stdout.rows) || getCtxVar('LINES') || 24),
                };
                baseVars.PATH = effectivePath;
                const subContext = {
                    vars: baseVars,
                    aliases: (this.context && this.context.aliases) || {},
                    getVar: (v) => (v === 'PATH' ? effectivePath : (baseVars[v] || getCtxVar(v))),
                    getAlias: (a) => (this.context && typeof this.context.getAlias === 'function') ? this.context.getAlias(a) : null,
                    getCommand: (c) => (this.context && typeof this.context.getCommand === 'function') ? this.context.getCommand(c) : null,
                };
                const ScriptCommand = require('../ScriptCommand');
                const scriptContent = fs.getFileByPath(scriptPath);
                instance = new ScriptCommand(scriptContent, args, subContext);
                instance.fs = fs;
            } else {
                const entries = this._buildCommandsForPackage(pkgMeta);
                // Find matching entry if user specified e.g. `wbt run asrun` or `wbt run wasm2wat`
                const matched = entries.find(e => e.bin === rawLower) || entries[0];
                const Cmd = matched.Cmd;
                instance = new Cmd(args, this.context);
                if (instance.requiresFilesystem) {
                    instance.fs = typeof fs.sandbox === 'function' ? fs.sandbox() : fs;
                }
            }

            // Pipe I/O and forward interactivity
            this._activeSubCommand = instance;
            if (this._onStdinStreamData && this.stdinStream && typeof this.stdinStream.off === 'function') {
                this.stdinStream.off('data', this._onStdinStreamData);
            }
            instance.stdinStream = this.stdinStream;
            instance.stdin = (this.stdin && !this.stdin.isTTY) ? this.stdin : this.stdinStream;
            if (instance._onStdinStreamData && this.stdinStream && typeof this.stdinStream.on === 'function') {
                this.stdinStream.on('data', instance._onStdinStreamData);
            }

            if (this.stdout && instance.stdout) {
                if (this.stdout.columns) instance.stdout.columns = this.stdout.columns;
                if (this.stdout.rows) instance.stdout.rows = this.stdout.rows;
            }
            if (this.stderr && instance.stderr) {
                if (this.stderr.columns) instance.stderr.columns = this.stderr.columns;
                if (this.stderr.rows) instance.stderr.rows = this.stderr.rows;
            }
            const onParentStdoutResize = () => {
                if (!this.stdout || !instance.stdout) return;
                if (typeof instance.stdout.resize === 'function') {
                    instance.stdout.resize(this.stdout.columns, this.stdout.rows);
                } else {
                    instance.stdout.columns = this.stdout.columns;
                    instance.stdout.rows = this.stdout.rows;
                }
            };
            if (this.stdout && typeof this.stdout.on === 'function') {
                this.stdout.on('resize', onParentStdoutResize);
            }

            const onStdout = (chunk) => {
                if (this.stdout && typeof this.stdout.write === 'function') this.stdout.write(chunk);
            };
            const onStderr = (chunk) => {
                if (this.stderr && typeof this.stderr.write === 'function') this.stderr.write(chunk);
            };
            const onFlush = (flushed) => {
                const lines = Array.isArray(flushed)
                    ? flushed
                    : (flushed && typeof flushed.getStdOutput === 'function' ? flushed.getStdOutput() : []);
                for (const line of lines) {
                    if (line.type === 'out') this.stdOut = line.string;
                    else if (line.type === 'err') this.stdErr = line.string;
                }
                this.flush();
            };
            if (instance.stdout && typeof instance.stdout.on === 'function') {
                instance.stdout.on('data', onStdout);
            }
            if (instance.stderr && typeof instance.stderr.on === 'function') {
                instance.stderr.on('data', onStderr);
            }
            if (typeof instance.on === 'function') {
                instance.on('flush', onFlush);
            }

            let res;
            try {
                res = await instance.runCommand();
            } finally {
                this._activeSubCommand = null;
                if (this.stdout && typeof this.stdout.off === 'function') {
                    this.stdout.off('resize', onParentStdoutResize);
                }
                if (instance._onStdinStreamData && this.stdinStream && typeof this.stdinStream.off === 'function') {
                    this.stdinStream.off('data', instance._onStdinStreamData);
                }
                if (this._onStdinStreamData && this.stdinStream && typeof this.stdinStream.on === 'function') {
                    this.stdinStream.on('data', this._onStdinStreamData);
                }
                if (instance.stdout && typeof instance.stdout.off === 'function') {
                    instance.stdout.off('data', onStdout);
                }
                if (instance.stderr && typeof instance.stderr.off === 'function') {
                    instance.stderr.off('data', onStderr);
                }
                if (typeof instance.removeListener === 'function') {
                    instance.removeListener('flush', onFlush);
                }
            }
            if (!instance.interactive && res) {
                for (const line of res.getStdOutput()) {
                    if (line.type === 'out') this.stdOut = line.string;
                    else if (line.type === 'err') this.stdErr = line.string;
                }
            }
            this.exitCode = res ? res.getExitCode() : 0;
        } finally {
            if (tempDir && fs) {
                try {
                    fs.deleteFileByPath(tempDir);
                } catch {
                    // ignore
                }
            }
        }
    }

    _printHelp() {
        [
            'wbt 1.1.0 — Web Binary Tool (WASM binary manager & runtime for brsh)',
            'Usage: wbt [options] command [package ...]',
            '',
            'Commands:',
            '  install <pkg> [url]   Install a WASM binary from registry, npm:<pkg>, or a custom URL',
            '  remove <pkg>          Remove an installed WASM binary',
            '  update                Update package index and restore installed binaries',
            '  list [--installed]    List available or installed WASM binaries',
            '  search <query>        Search available WASM binaries by name or description',
            '  show <pkg>            Show detailed information about a package',
            '  run <pkg> [args...]   Run a WASM binary without permanently installing it',
            '',
            'Curated WASM Packages:',
            '  sqlite3               SQLite3 compiled to WebAssembly (sqlite3, sqlite)',
            '  assemblyscript        AssemblyScript compiler & ts-node style runtime (asc, asrun, asnode)',
            '  jq                    Command-line JSON processor (jq)',
            '  python3               CPython 3.12 via Pyodide (python3, python, py)',
            '  duckdb                DuckDB analytical SQL OLAP engine (duckdb)',
            '  graphviz              Graphviz DOT diagram compiler (dot)',
            '  ffmpeg                FFmpeg multimedia transcoder (ffmpeg)',
            '  wabt                  WebAssembly Binary Toolkit (wat2wasm, wasm2wat)',
            '  quickjs               Sandboxed QuickJS JavaScript engine (qjs)',
            '  lua                   Lua 5.4 WebAssembly interpreter (lua)',
            '  wllama                WASM & WebGPU LLM inference engine (wllama, llama, llama-cli)',
            '  nano                  GNU nano 8.0 text editor with ncurses (nano, nano-wasm)',
            '  doom                  Classic Doom (1993) with 24-bit ANSI rendering (doom, freedoom)'
        ].forEach(l => { this.stdOut = l; });
    }
}

module.exports = Wbt;
module.exports.Wbt = Wbt;
module.exports.DEFAULT_REGISTRY = DEFAULT_REGISTRY;
module.exports.createGenericWasmCommand = createGenericWasmCommand;
module.exports.createReplWasmCommand = createReplWasmCommand;

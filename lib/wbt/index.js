'use strict';

const LocalCommand = require('../local/LocalCommand');
const WasmCommand = require('../WasmCommand');
const ReplCommand = require('../ReplCommand');
const { DEFAULT_REGISTRY, resolvePackageName } = require('./registry');
const { writeBytesToFs, createGenericWasmCommand } = WasmCommand;
const { createReplWasmCommand } = ReplCommand;
const { daemonManager } = require('./daemon');

const { createPgliteCommand, createPgCtlCommand } = require('./packages/pglite');

const STATE_FILE = '/var/lib/wbt/installed.json';
const CACHE_DIR = '/var/cache/wbt';

const ADAPTER_FACTORIES = {
    pglite: (meta, cfg) => [
        { bin: meta.bin || 'pglite', Cmd: createPgliteCommand(meta, cfg, 'pglite') },
        { bin: 'psql', Cmd: createPgliteCommand(meta, cfg, 'psql') },
        { bin: 'pg_ctl', Cmd: createPgCtlCommand(meta, cfg) }
    ]
};

/**
 * Creates a Command class that executes a custom installed WASM or WAT file at `wasmPath`.
 */
function createCustomWasmBinCommand(binName, wasmPath, pkgMeta = {}) {
    class CustomWasmBin extends WasmCommand {
        static get name() { return binName; }
        get name() { return binName; }

        constructor(args, context) {
            super(wasmPath, args, context);
            this.script = wasmPath;
            this.arguments = args || [];
            this.context = context || null;
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
class Wbt extends LocalCommand {
    static get name() { return 'wbt'; }
    get name() { return 'wbt'; }
    get requiresFilesystem() { return true; }

    static get _config() {
        return this.__wbtConfig || {};
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
     * Restores any packages previously recorded in `/var/lib/wbt/installed.json`
     * into the given Shell or Context (useful when loading a persisted virtual filesystem).
     */
    static restoreInstalled(shellOrContext, config = {}) {
        const ctx = shellOrContext.context || shellOrContext;
        if (!ctx || !ctx.fs) return;
        const instance = new (this.configure(config))([], ctx);
        instance.fs = ctx.fs.sandbox();
        instance._restoreCommands();
    }

    _getRegistry() {
        const cfg = this.constructor._config || {};
        const base = Object.assign({}, DEFAULT_REGISTRY, cfg.registry || {});
        try {
            const cachedRemote = this.context.fs._getFileRaw(`${CACHE_DIR}/remote-registry.json`);
            if (typeof cachedRemote === 'string' && cachedRemote.trim()) {
                const parsed = JSON.parse(cachedRemote);
                Object.assign(base, parsed);
            }
        } catch {
            // ignore
        }
        return base;
    }

    _readState() {
        try {
            const raw = this.context.fs._getFileRaw(STATE_FILE);
            if (typeof raw === 'string' && raw.trim()) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object' && parsed.packages) {
                    return parsed;
                }
            }
        } catch {
            // ignore
        }
        return { packages: {} };
    }

    _writeState(state) {
        this.context.fs._setFileRaw(STATE_FILE, JSON.stringify(state, null, 2), true);
    }

    _buildCommandsForPackage(pkgMeta) {
        const cfg = this.constructor._config || {};

        if (pkgMeta.type === 'custom-wasm' && pkgMeta.wasmPath) {
            const binName = (pkgMeta.bin || pkgMeta.name).toLowerCase();
            return [{ bin: binName, Cmd: createCustomWasmBinCommand(binName, pkgMeta.wasmPath, pkgMeta) }];
        }

        const factory = ADAPTER_FACTORIES[pkgMeta.adapter || pkgMeta.name];
        if (factory) {
            return factory(pkgMeta, cfg);
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
        const pathDir = this.context.getVar('PATH') || '/bin';
        const entries = this._buildCommandsForPackage(pkgMeta);
        const installedBins = [];

        for (const { bin, Cmd } of entries) {
            const binName = bin.toLowerCase();
            this._installBin(pathDir, binName, Cmd);
            installedBins.push(binName);
        }

        // Also register any aliases not already created by the factory
        for (const alias of (pkgMeta.aliases || [])) {
            const aliasLower = alias.toLowerCase();
            if (!installedBins.includes(aliasLower) && entries.length > 0) {
                const PrimaryCmd = entries[0].Cmd;
                class AliasCommand extends PrimaryCmd {
                    static get name() { return aliasLower; }
                    get name() { return aliasLower; }
                }
                this._installBin(pathDir, aliasLower, AliasCommand);
                installedBins.push(aliasLower);
            }
        }

        return installedBins;
    }

    _installBin(pathDir, binName, Cmd) {
        const location = `${pathDir}/${binName}`;
        this.context.fs.addFiles({ [location]: Cmd });
        this.context.fs.setMode(location, 0o555);
    }

    _removeBin(pathDir, binName) {
        const location = `${pathDir}/${binName.toLowerCase()}`;
        if (this.context.fs._deleteByAbsolutePath) {
            this.context.fs._deleteByAbsolutePath(location);
            this.context.fs._triggerChange();
        } else {
            try { this.context.fs.deleteFileByPath(location); } catch { /* ignore */ }
        }
    }

    _restoreCommands() {
        const state = this._readState();
        const registry = this._getRegistry();
        for (const [pkgName, record] of Object.entries(state.packages)) {
            const meta = registry[pkgName] || record;
            if (meta) {
                try {
                    this._registerPackageIntoContext(meta);
                } catch {
                    // ignore
                }
            }
        }
    }

    async run() {
        const args = [...(this.arguments || [])];
        if (args.length === 0 || args.includes('--help') || args.includes('-h') || args[0] === 'help') {
            this._printHelp();
            return;
        }

        if (args.includes('--version') || args.includes('-v')) {
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
            case 'services':
            case 'daemons':
            case 'ps':
                await this._handleServices(args);
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
        const state = this._readState();
        let printedHeader = false;

        for (let i = 0; i < positional.length; i++) {
            const rawName = positional[i];

            // Case A: `<name> <url>` pair (current token is not a URL, next token is a URL)
            if (!isUrl(rawName) && i + 1 < positional.length && isUrl(positional[i + 1])) {
                const url = positional[++i];
                const pkgName = (asName || rawName).toLowerCase();
                await this._installCustomUrl(pkgName, url, quiet, state);
                if (this.exitCode) return;
                continue;
            }

            // Case B: standalone `<url>` (with optional `--as <name>`)
            if (isUrl(rawName)) {
                const url = rawName;
                const pkgName = (asName || deriveUrlBinName(url)).toLowerCase();
                await this._installCustomUrl(pkgName, url, quiet, state);
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

            if (state.packages[pkgMeta.name] && !flags.includes('--reinstall') && !flags.includes('-f')) {
                if (!quiet) {
                    this.stdOut = `${pkgMeta.name} is already the newest version (${pkgMeta.version}).`;
                }
                continue;
            }

            if (!quiet) {
                this.stdOut = `Get:1 ${pkgMeta.cdnUrl} ${pkgMeta.name} ${pkgMeta.version} [${pkgMeta.size || 'WASM'}]`;
                this.stdOut = `Unpacking ${pkgMeta.name} (${pkgMeta.version}) ...`;
                this.flush();
            }

            // Optional eager preload when `--preload` is passed
            if (flags.includes('--preload')) {
                const cfg = this.constructor._config || {};
                const { loadModule } = require('./utils');
                try {
                    await loadModule(pkgMeta.name, pkgMeta.cdnUrl, cfg.moduleLoader);
                } catch (err) {
                    this.stdErr = `E: Failed to fetch ${pkgMeta.name}: ${err.message || err}`;
                    this.exitCode = 1;
                    return;
                }
            }

            const bins = this._registerPackageIntoContext(pkgMeta);
            state.packages[pkgMeta.name] = {
                name: pkgMeta.name,
                bin: pkgMeta.bin,
                bins,
                aliases: pkgMeta.aliases || [],
                version: pkgMeta.version,
                description: pkgMeta.description,
                cdnUrl: pkgMeta.cdnUrl,
                type: pkgMeta.type,
                adapter: pkgMeta.adapter,
                repl: pkgMeta.repl,
                installedAt: new Date().toISOString()
            };

            if (!quiet) {
                this.stdOut = `Setting up ${pkgMeta.name} (${pkgMeta.version}) -> /bin/${bins.join(', /bin/')} ...`;
            }
        }

        this._writeState(state);
    }

    async _installCustomUrl(pkgName, url, quiet = false, existingState = null) {
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
            this._registerPackageIntoContext(pkgMeta);
            const state = existingState || this._readState();
            state.packages[pkgName] = pkgMeta;
            this._writeState(state);
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

        let res;
        try {
            res = await fetchFn(url);
        } catch (err) {
            this.stdErr = `E: Failed to fetch ${url}: ${err.message || err}`;
            this.exitCode = 1;
            return;
        }

        if (!res || !res.ok) {
            this.stdErr = `E: HTTP ${res ? res.status : 'error'} fetching ${url}`;
            this.exitCode = 1;
            return;
        }

        const isWat = url.endsWith('.wat');
        const ext = isWat ? '.wat' : '.wasm';
        const wasmPath = `/var/lib/wbt/wasm/${pkgName}${ext}`;

        if (isWat) {
            const text = await res.text();
            this.context.fs._setFileRaw(wasmPath, text, true);
        } else {
            const ab = await res.arrayBuffer();
            writeBytesToFs(this.fs, wasmPath, new Uint8Array(ab), 'application/wasm');
        }
        this.context.fs.setMode(wasmPath, 0o755);

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
        const state = existingState || this._readState();
        state.packages[pkgName] = pkgMeta;
        this._writeState(state);

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

        const state = this._readState();
        const pathDir = this.context.getVar('PATH') || '/bin';

        for (const rawName of positional) {
            const pkgName = resolvePackageName(rawName);
            const record = state.packages[pkgName] || state.packages[rawName.toLowerCase()];

            if (!record) {
                this.stdErr = `E: Package '${rawName}' is not installed, so not removed`;
                this.exitCode = 1;
                return;
            }

            const binsToRemove = record.bins || [record.bin || record.name, ...(record.aliases || [])];
            for (const b of binsToRemove) {
                this._removeBin(pathDir, b);
            }

            if (record.wasmPath) {
                try { this.context.fs.deleteFileByPath(record.wasmPath); } catch { /* ignore */ }
            }

            delete state.packages[record.name];
            this.stdOut = `Removing ${record.name} (${record.version}) ...`;
        }

        this._writeState(state);
    }

    _handleList(args) {
        const installedOnly = args.includes('--installed') || args.includes('-i');
        const registry = this._getRegistry();
        const state = this._readState();

        this.stdOut = 'Listing...';

        const names = installedOnly
            ? Object.keys(state.packages).sort()
            : Array.from(new Set([...Object.keys(registry), ...Object.keys(state.packages)])).sort();

        for (const name of names) {
            const reg = registry[name];
            const inst = state.packages[name];
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
        const state = this._readState();

        this.stdOut = 'Sorting... Done';
        this.stdOut = 'Full Text Search... Done';

        const entries = Object.values(registry).filter(pkg => {
            if (!query) return true;
            return (
                pkg.name.toLowerCase().includes(query) ||
                (pkg.bin && pkg.bin.toLowerCase().includes(query)) ||
                (pkg.aliases && pkg.aliases.some(a => a.toLowerCase().includes(query))) ||
                (pkg.description && pkg.description.toLowerCase().includes(query)) ||
                (pkg.details && pkg.details.toLowerCase().includes(query))
            );
        });

        for (const pkg of entries) {
            const inst = state.packages[pkg.name] ? ' [installed]' : '';
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
        const state = this._readState();
        const meta = state.packages[pkgName] || registry[pkgName];

        if (!meta) {
            this.stdErr = `E: No packages found matching ${rawName}`;
            this.exitCode = 100;
            return;
        }

        const full = Object.assign({}, registry[pkgName] || {}, meta);
        const isInstalled = Boolean(state.packages[full.name]);

        this.stdOut = `Package: ${full.name}`;
        this.stdOut = `Version: ${full.version}`;
        this.stdOut = `State: ${isInstalled ? 'installed' : 'not installed'}`;
        this.stdOut = `Binary: ${full.bin || full.name}`;
        if (full.aliases && full.aliases.length > 0) {
            this.stdOut = `Aliases: ${full.aliases.join(', ')}`;
        }
        if (full.size) {
            this.stdOut = `Download-Size: ${full.size}`;
        }
        if (full.cdnUrl) {
            this.stdOut = `APT-Sources: ${full.cdnUrl}`;
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
            this.context.fs._setFileRaw(`${CACHE_DIR}/remote-registry.json`, JSON.stringify(mergedRemote, null, 2), true);
        }

        // Also ensure any installed packages in state are registered in PATH
        this._restoreCommands();

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
        const state = this._readState();
        let pkgMeta = state.packages[pkgName] || registry[pkgName];

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

        const entries = this._buildCommandsForPackage(pkgMeta);
        // Find matching entry if user specified e.g. `wbt run asrun` or `wbt run wasm2wat`
        const matched = entries.find(e => e.bin === rawName.toLowerCase()) || entries[0];
        const Cmd = matched.Cmd;

        const instance = new Cmd(args, this.context);
        if (instance.requiresFilesystem) {
            instance.fs = this.context.fs.sandbox();
        }
        if (this.stdin !== undefined) {
            instance.stdin = this.stdin;
        }
        const res = await instance.runCommand();
        for (const line of res.getStdOutput()) {
            if (line.type === 'out') this.stdOut = line.string;
            else if (line.type === 'err') this.stdErr = line.string;
        }
        this.exitCode = res.getExitCode();
    }

    async _handleServices(args) {
        const sub = (args[0] || 'list').toLowerCase();
        if (sub === 'stop' && args[1]) {
            const stopped = await daemonManager.stopDaemon(args[1]);
            if (!stopped) {
                this.stdErr = `E: No running service matching '${args[1]}'`;
                this.exitCode = 1;
                return;
            }
            this.stdOut = `Stopped service ${stopped.name} (PID ${stopped.pid}, port ${stopped.port})`;
            return;
        }

        const list = daemonManager.listDaemons();
        if (list.length === 0) {
            this.stdOut = 'No WASM background services currently running.';
            return;
        }
        this.stdOut = 'PID   SERVICE    PORT   HOST        DATADIR';
        for (const d of list) {
            this.stdOut = `${String(d.pid).padEnd(5)} ${d.name.padEnd(10)} ${String(d.port).padEnd(6)} ${d.host.padEnd(11)} ${d.dataDir}`;
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
            '  services [stop <id>]  List or stop running WASM background server daemons',
            '',
            'Curated WASM Packages:',
            '  pglite                WASM PostgreSQL database, REPL & daemon (pglite, psql, pg_ctl)',
            '  sqlite3               SQLite3 compiled to WebAssembly (sqlite3, sqlite)',
            '  assemblyscript        AssemblyScript compiler & ts-node style runtime (asc, asrun, asnode)',
            '  jq                    Command-line JSON processor (jq)',
            '  python3               CPython 3.12 via Pyodide (python3, python, py)',
            '  duckdb                DuckDB analytical SQL OLAP engine (duckdb)',
            '  graphviz              Graphviz DOT diagram compiler (dot)',
            '  ffmpeg                FFmpeg multimedia transcoder (ffmpeg)',
            '  wabt                  WebAssembly Binary Toolkit (wat2wasm, wasm2wat)',
            '  quickjs               Sandboxed QuickJS JavaScript engine (qjs)',
            '  lua                   Lua 5.4 WebAssembly interpreter (lua)'
        ].forEach(l => { this.stdOut = l; });
    }
}

module.exports = Wbt;
module.exports.Wbt = Wbt;
module.exports.DEFAULT_REGISTRY = DEFAULT_REGISTRY;
module.exports.daemonManager = daemonManager;
module.exports.createGenericWasmCommand = createGenericWasmCommand;
module.exports.createReplWasmCommand = createReplWasmCommand;

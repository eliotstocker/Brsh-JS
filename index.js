'use strict';

const Context = require('./lib/Context');
const LocalCommand = require('./lib/local/LocalCommand');
const ScriptCommand = require('./lib/ScriptCommand');
const WasmCommand = require('./lib/WasmCommand');
const Command = require('./lib/Command');
const InteractiveCommand = require('./lib/InteractiveCommand');

const builtins = require('./lib/builtins');
const localCommands = require('./lib/local');
const events = require('events');
const BaseFileSystem = require('./lib/BaseFileSystem');

<<<<<<< HEAD
const variableRegex = /\$(?:\{([\w\d?#-]+)\}|([\w\d]+|[?#-]))/g;
=======
const BinaryContainer = require('./lib/BinaryContainer');
const { isAsyncFilesystemSource, resolveFilesystemSource } = BinaryContainer;

const variableRegex = /\${?([\w\d]+)}?/g;
>>>>>>> a7cdd96 (feat: support passing .brfs URLs, Promises, and gzipped containers directly to Shell/Terminal)


const EventEmitter = events.EventEmitter || events.default || events;
//shims etc
String.prototype.regexIndexOf = function(regex, startpos) {
    const indexOf = this.substring(startpos || 0).search(regex);
    return (indexOf >= 0) ? (indexOf + (startpos || 0)) : indexOf;
};
require('string.prototype.matchall').shim();

class Shell extends EventEmitter {
    constructor(options) {
        super();
        const {
            path = '/bin',
            profile,
            motd,
            command,
            interactive = true,
            subshell = false,
            hostname = 'browser',
            filesystem = {},
            permissions = {},
            cwd = '/',
            onFsChange,
            useRealFilesystem = false
        } = options;

        this.context = new Context(Object.assign({}, options, {
            clearFn: this.clear.bind(this),
            destroyFn: this.destroy.bind(this),
            onFsChange: typeof onFsChange === 'function' ? onFsChange : null
        }));

        this._readonlyContext = Object.freeze({
            getVar:     (v) => this.context.getVar(v),
            getAlias:   (a) => this.context.getAlias(a),
            getCommand: (c) => this.context.getCommand(c),
        });

        this.context.setVar('PATH', path);
        this.context.setVar('HOST', hostname);
        if (!subshell) {
            const initialFlags = (interactive ? 'i' : '') + (command ? 'c' : '');
            if (initialFlags) {
                this.context.setVar('-', initialFlags);
            }
        }
        this._lastCode = 0;
        this._subshell = subshell;
        this._useRealFilesystem = useRealFilesystem;
        this._profile = profile;
        this._motd = motd;
        this._initialCommand = command || null;
        this._suppressMotd = Boolean(command);
        this._loadingFs = null;
        this._queuedWhileLoading = false;

        if (useRealFilesystem) {
            this.context.setNodeFilesystem(cwd);
            this.context.setCwd(cwd);
            this._loadDefaultCommands();
            this._loadBuiltinCommands(true);
            this.ready = Promise.resolve(this);
            if (!subshell) {
                this._initializing = true;
                setTimeout(() => this._init(), 0);
            } else {
                this._initializing = false;
            }
        } else if (isAsyncFilesystemSource(filesystem) || (filesystem && typeof filesystem === 'object' && isAsyncFilesystemSource(filesystem.filesystem))) {
            // Initialize a temporary empty filesystem so synchronous calls like `shell.context.setCommand(Wbt)` work immediately
            this.context.setFilesystem({}, permissions);
            this._loadDefaultCommands();
            this._loadBuiltinCommands(false);
            this._initializing = !subshell;
            this._loadingFs = this._initAsyncFilesystem(filesystem, permissions, cwd, profile);
            this.ready = this._loadingFs;
        } else {
            this.context.setFilesystem(filesystem, permissions);
            this.context.setCwd(cwd);

            const pathDirExisted = this.context.fs.exists(this.context.getVar('PATH'));
            this._loadDefaultCommands();
            this._loadBuiltinCommands(pathDirExisted);
            this.ready = Promise.resolve(this);

            if (!subshell) {
                this._initializing = true;
                setTimeout(() => this._init(), 0);
            } else {
                this._initializing = false;
            }
        }
    }

    async _initAsyncFilesystem(filesystemSource, permissions, cwd) {
        const binPath = this.context.getVar('PATH') || '/bin';
        const getBinSnapshot = () => {
            try {
                const raw = this.context.fs.getRaw();
                const parts = binPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
                let dir = raw;
                for (const p of parts) {
                    dir = dir && dir[p];
                }
                return dir && typeof dir === 'object' ? Object.assign({}, dir) : {};
            } catch (_) {
                return {};
            }
        };

        const defaultBinSnapshot = getBinSnapshot();
        try {
            const resolved = await resolveFilesystemSource(filesystemSource, permissions);
            const postBinSnapshot = getBinSnapshot();

            // Preserve any custom commands registered via `shell.context.setCommand(...)` while the async load was in flight
            const customCommands = [];
            for (const [k, v] of Object.entries(postBinSnapshot)) {
                if (defaultBinSnapshot[k] !== v && typeof v === 'function') {
                    customCommands.push(v);
                }
            }

            // Temporarily suppress onFsChange during initial mount
            const savedOnChange = this.context._onFsChange;
            this.context._onFsChange = null;
            this.context.setFilesystem(resolved.filesystem, resolved.permissions);
            const pathDirExisted = this.context.fs.exists(binPath);
            this._loadDefaultCommands();
            this._loadBuiltinCommands(pathDirExisted);
            for (const cmd of customCommands) {
                this.context.setCommand(cmd);
            }
            this.context.setCwd(cwd);
            this.context._onFsChange = savedOnChange;
            if (savedOnChange && this.context.fs) {
                this.context.fs._onChange = () => savedOnChange(this.context.fs.getRaw(), this.context.fs.getRawPermissions());
            }
        } catch (err) {
            this.emit('stdErr', err.message || String(err));
        } finally {
            this._loadingFs = null;
        }

        if (!this._subshell) {
            await this._init();
        } else {
            this._initializing = false;
            if (!this._queuedWhileLoading && !this.destroyed) {
                this.emit('status', Shell.STATUS_READY);
            }
        }
        return this;
    }

    get path() {
        return this.context.getVar('PATH');
    }

    set lastCode(code) {
        this.context.setVar('?', String(code));
        this._lastCode = code;
    }

    get lastCode() {
        return this._lastCode;
    }

    set stdin(data) {
        this._stdin = data;
    }

    onInput(char) {
        if(this.runningCommand && this.runningCommand.onInput && this.runningCommand.captureInput) {
            this.runningCommand.onInput(char);
            return true;
        }
    }

    setTerminalSize(cols, rows) {
        this._terminalSize = { cols, rows };
        this.context.setVar('COLUMNS', String(cols));
        this.context.setVar('LINES', String(rows));
        this.emit('resize', { cols, rows });
    }

    get terminalSize() {
        return this._terminalSize || { cols: 80, rows: 24 };
    }

    _loadDefaultCommands() {
        localCommands.forEach(command => {
            this.context.setCommand(command);
        });
    }

    _loadBuiltinCommands(pathDirExisted = false) {
        builtins.forEach(command => {
            this.context.setCommand(command);
        });
        // Lock the bin directory only if we implicitly created it.
        // If the caller supplied their own bin dir, respect their permissions.
        if (!pathDirExisted) {
            this.context.fs.setMode(this.context.getVar('PATH'), 0o555);
        }
    }

    suppressMotd() {
        this._suppressMotd = true;
        const flags = this.context.getVar('-');
        if (!flags.includes('c')) {
            this.context.setVar('-', flags + 'c');
        }
    }

    async _init() {
        try {
            if (!this._suppressMotd && !this._initialCommand) {
                await this._runMotd();
            }
            await this._loadProfile(this._profile);
            if (this._initialCommand) {
                await this.onCommand(this._initialCommand, false);
                const flags = this.context.getVar('-');
                if (flags.includes('c')) {
                    this.context.setVar('-', flags.replace(/c/g, ''));
                }
            }
        } finally {
            this._initializing = false;
            if (!this._queuedWhileLoading && !this.destroyed) {
                this.emit('status', Shell.STATUS_READY);
            }
        }
    }

    _hasHushlogin() {
        if (this.context.fs.exists('.hushlogin')) return true;
        const home = this.context.getVar('HOME');
        if (home && this.context.fs.exists(`${home.replace(/\/$/, '')}/.hushlogin`)) return true;
        return false;
    }

    async _runMotd() {
        if (this._motd === false || this._hasHushlogin()) return;
        if (typeof this._motd === 'string') {
            await this._renderMotdPath(this._motd);
            return;
        }
        if (!this._useRealFilesystem) {
            if (this.context.fs.exists('/etc/update-motd.d')) {
                await this._runMotdDir('/etc/update-motd.d');
            }
            if (this.context.fs.exists('/etc/motd')) {
                await this._renderMotdPath('/etc/motd');
            }
        }
    }

    async _runMotdDir(dirPath) {
        const dir = this.context.fs.getFileByPath(dirPath);
        if (!dir || dir.constructor !== Object) return;
        const entries = Object.keys(dir).sort();
        const cleanDir = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;
        for (const name of entries) {
            const fullPath = `${cleanDir}/${name}`;
            const stat = this.context.fs.stat(fullPath);
            if (!stat || stat.isDirectory) continue;
            if (this.context.fs.isExecutable(fullPath)) {
                await this.onCommand(fullPath, false);
            }
        }
    }

    async _renderMotdPath(motdPath) {
        if (!this.context.fs.exists(motdPath)) return;
        const stat = this.context.fs.stat(motdPath);
        if (!stat) return;
        if (stat.isDirectory) {
            await this._runMotdDir(motdPath);
            return;
        }
        const content = this.context.fs.getFileByPath(motdPath);
        if (content === null || content === undefined) return;

        if (typeof content === 'function') {
            if (this.context.fs.isExecutable(motdPath)) {
                await this.onCommand(motdPath, false);
            }
            return;
        }

        if (typeof content === 'string' && content.startsWith('#!')) {
            if (this.context.fs.isExecutable(motdPath)) {
                await this.onCommand(motdPath, false);
            } else {
                await this.onCommand(`source ${motdPath}`, false);
            }
            return;
        }

        let text = content.toString();
        if (text.endsWith('\n')) text = text.slice(0, -1);
        text.split(/\r?\n/).forEach(line => {
            this.emit('stdOut', line);
        });
    }

    async _loadProfile(profile) {
        if (!this._useRealFilesystem && profile !== '/etc/profile' && this.context.fs.exists('/etc/profile')) {
            const etcProfile = this.context.fs.getFileByPath('/etc/profile');
            if (typeof etcProfile === 'string' && etcProfile.startsWith('#!')) {
                await this.onCommand('source /etc/profile', false);
            }
        }
        if (profile) {
            await this.onCommand(`source ${profile}`, false);
        }
    }

    onCommand(raw, events = true) {
        const segments = this._splitInput(raw);
        const groups = this._groupPipes(segments);
        let shouldRun = true;

        if (this._loadingFs && events) {
            this._queuedWhileLoading = true;
        }
        const initialPromise = this._loadingFs ? Promise.resolve(this._loadingFs) : Promise.resolve();

        const promise = groups.reduce((chain, { commands, op }) => {
            return chain.then(() => {
                if (!shouldRun) {
                    if (op === '&&') shouldRun = this._lastCode === 0;
                    else if (op === '||') shouldRun = this._lastCode !== 0;
                    else if (op === ';') shouldRun = true;
                    return;
                }
                return this._runPipeChain(commands).then(() => {
                    if (op === '&&') shouldRun = this._lastCode === 0;
                    else if (op === '||') shouldRun = this._lastCode !== 0;
                    else if (op === ';') shouldRun = true;
                });
            });
        }, initialPromise);

        if(events) {
            return promise.then(() => {
                if(!this.destroyed) {
                    this.emit('status', Shell.STATUS_READY);
                }
            })
                .catch(() => this.emit('status', Shell.STATUS_READY));
        }

        return promise;
    }

    tabCompletion(path) {
        return this.context.fs.autoComplete(path, this.path);
    }

    async _runCommand(command) {
        if(!command || command.length < 1) {
            return;
        }

        if (!this._initializing) {
            this.emit('status', Shell.STATUS_WORKING);
        }

        let args;
        try {
            args = await this._parseCommandLine(command);
        } catch(e) {
            this.emit('stdErr', e.message || String(e));
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return;
        }

        if (!args.length) return;
        let bin = args.shift().value;

        // Bare variable assignment: VAR=value (only when no additional args)
        if (args.length === 0 && /^[A-Za-z_]\w*=/.test(bin)) {
            const eqIdx = bin.indexOf('=');
            this.context.setVar(bin.slice(0, eqIdx), bin.slice(eqIdx + 1));
            this.lastCode = 0;
            this.emit('exitCode', 0);
            return;
        }

        // Parse output redirection (> and >>)
        // Quoted tokens (hasQuote: true) are never treated as redirects.
        let redirectPath = null;
        let appendMode = false;
        const filteredArgs = [];
        for (let i = 0; i < args.length; i++) {
            const { value: arg, hasQuote } = args[i];
            if (!hasQuote && (arg === '>>' || arg === '>') && i + 1 < args.length) {
                appendMode = arg === '>>';
                redirectPath = args[++i].value;
            } else if (!hasQuote && arg.startsWith('>>') && arg.length > 2) {
                appendMode = true;
                redirectPath = arg.slice(2);
            } else if (!hasQuote && arg.startsWith('>') && arg.length > 1) {
                appendMode = false;
                redirectPath = arg.slice(1);
            } else {
                filteredArgs.push(arg);
            }
        }
        args = filteredArgs;

        //short circuit for aliases
        const alias = this.context.getAlias(bin);
        if(alias) {
            return this.onCommand(alias, false);
        }

        let Cmd;
        try {
            Cmd = this._parseCommand(
            (bin.startsWith('/') || bin.startsWith('./')) ? bin : bin.toLowerCase()
        );
        } catch(e) {
            this.emit('stdErr', e.message);
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return;
        }

        const isCommandClass = (C) => typeof C === 'function' && typeof C.prototype.run === 'function' && typeof C.prototype.runCommand === 'function';
        let instance;
        if(Cmd.prototype instanceof LocalCommand || new Cmd() instanceof ScriptCommand) {
            instance = new Cmd(args, this.context);
        } else if(isCommandClass(Cmd)) {
            instance = new Cmd(args, this._readonlyContext);
        } else {
            this.emit('stdErr', `${bin}: Command not found`);
            this.lastCode = 1;
            this.emit('exitCode', this.lastCode);
            return;
        }

        if(instance.requiresFilesystem) {
            instance.fs = this.context.fs.sandbox();
        }

        if (this._stdin !== undefined) {
            instance.stdin = this._stdin;
        }

        this.runningCommand = instance;
        if(this.runningCommand.on) {
            this.runningCommand.on('flush', lines => {
                this._emitOutput(lines);
            });
        }
        if (instance.interactive) {
            this.emit('interactive');
        }

        return instance.runCommand().then(result => {
            const stdOutput = result.getStdOutput();

            if (redirectPath) {
                const absTarget = this.context.fs.absolutePath(redirectPath);
                const outLines = stdOutput.filter(l => l.type === 'out').map(l => l.string);
                const content = appendMode
                    ? (() => {
                        const existing = this.context.fs._getFileRaw(absTarget);
                        return typeof existing === 'string'
                            ? existing + '\n' + outLines.join('\n')
                            : outLines.join('\n');
                    })()
                    : outLines.join('\n');
                try {
                    this.context.fs.setFileByPath(absTarget, content, true);
                } catch (e) {
                    this.emit('stdErr', `${redirectPath}: Permission denied`);
                    this.lastCode = 1;
                    this.emit('exitCode', this.lastCode);
                    delete this.runningCommand;
                    return;
                }
                this._emitOutput(stdOutput.filter(l => l.type === 'err'));
            } else {
                this._emitOutput(stdOutput);
            }

            this.lastCode = result.getExitCode();
            this.emit('exitCode', this.lastCode);
            delete this.runningCommand;
        });
    }

    _emitOutput(lines) {
        lines.forEach(({type, string}) => {
            if(type === 'out') {
                this.emit('stdOut', string);
            } else if(type === 'err') {
                this.emit('stdErr', string);
            }
        });
    }

    getPrompt() {
        const path = this.context.fs.cwd.split('/');
        return `${this.context.getVar('HOST')}:${path[path.length -2]}$`;
    }

    destroy(code = 0) {
        if(!this.destroyed) {
            this.destroyed = true;
            this.emit('status', Shell.STATUS_DESTROYED);
            this.emit('exit', code);
        }
    }

    clear() {
        this.emit('clear');
    }

    _splitInput(input) {
        const commentStripped = input.split('#')[0];
        return this._parseOperators(commentStripped);
    }

    _parseOperators(input) {
        const segments = [];
        let current = '';
        let i = 0;
        let sq = false, dq = false;

        while (i < input.length) {
            const ch = input[i];
            if (ch === "'" && !dq) { sq = !sq; current += ch; i++; continue; }
            if (ch === '"' && !sq) { dq = !dq; current += ch; i++; continue; }
            if (!sq && !dq) {
                if (ch === '&' && input[i + 1] === '&') {
                    segments.push({ command: current.trim(), op: '&&' });
                    current = ''; i += 2; continue;
                }
                if (ch === '|' && input[i + 1] === '|') {
                    segments.push({ command: current.trim(), op: '||' });
                    current = ''; i += 2; continue;
                }
                if (ch === '|') {
                    segments.push({ command: current.trim(), op: '|' });
                    current = ''; i++; continue;
                }
                if (ch === ';') {
                    segments.push({ command: current.trim(), op: ';' });
                    current = ''; i++; continue;
                }
            }
            current += ch; i++;
        }
        if (current.trim()) segments.push({ command: current.trim(), op: null });
        return segments;
    }

    _parseCommand(command) {
        if(command.startsWith('./') || command.startsWith('/')) {
            const handle = this.context.fs._getFileRaw(command);
            if(!handle) {
                throw new Error(`${command}: No such file or directory`);
            }

            if(handle.constructor === Object) {
                throw new Error(`${command}: is a directory`);
            }

            if(handle.prototype && typeof handle.prototype.run === 'function' && typeof handle.prototype.runCommand === 'function') {
                if (!this.context.fs.isExecutable(command)) {
                    throw new Error(`${command}: permission denied`);
                }
                return handle;
            }

            if(handle.constructor === String && handle.startsWith('#!')) {
                if (!this.context.fs.isExecutable(command)) {
                    throw new Error(`${command}: permission denied`);
                }
                return ScriptCommand.bind(this, handle);
            }

            if(this._isWasmFile(command, handle)) {
                if (!this.context.fs.isExecutable(command)) {
                    throw new Error(`${command}: permission denied`);
                }
                return WasmCommand.bind(null, command);
            }

            // Executable .js files on the real filesystem: load via require() as a Command class.
            if (this.context.fs.isRealFilesystem && typeof handle === 'string' && command.endsWith('.js')) {
                if (!this.context.fs.isExecutable(command)) {
                    throw new Error(`${command}: permission denied`);
                }
                const abs = this.context.fs.absolutePath(command);
                try {
                    const mod = require(abs);
                    const Cls = mod.default || mod;
                    if (typeof Cls === 'function' && typeof Cls.prototype.run === 'function' && typeof Cls.prototype.runCommand === 'function') {
                        return Cls;
                    }
                } catch(e) {
                    // Not a loadable command module — fall through
                }
            }

            throw new Error(`${command}: permission denied`);
        }
        let cmd = this.context.getCommand(command);
        let cmdName = command;
        if (!cmd && !command.endsWith('.wasm')) {
            cmd = this.context.getCommand(`${command}.wasm`);
            if (cmd) cmdName = `${command}.wasm`;
        }

        if(!cmd) {
            throw new Error(`${command}: Command not found`);
        }

        const binLocation = `${this.path}/${cmdName}`;
        if (this._isWasmFile(binLocation, cmd)) {
            return WasmCommand.bind(null, binLocation);
        }

        if (typeof cmd === 'string' && cmd.startsWith('#!')) {
            return ScriptCommand.bind(this, cmd);
        }

        return cmd;
    }

    async _parseCommandLine(string) {
        const parts = Shell._splitCommand(string);
        const replaced = await Promise.all(
            parts.map(({ value, hasQuote }) =>
                this._replaceVariables(value).then(v => ({ value: v, hasQuote }))
            )
        );
        // Keep tokens that are non-empty OR were explicitly quoted (preserves "" → '')
        // Preserve hasQuote so redirect detection can skip quoted tokens.
        return replaced
            .filter(({ value, hasQuote }) => value.length > 0 || hasQuote);
    }

    static _sanitiseCommandPart(string) {
        return (string.startsWith('"') && string.endsWith('"'))
            || (string.startsWith("'") && string.endsWith("'"))
            ? string.substring(1, string.length - 1) : string;
    }

    static _sanitiseArray(array) {
        return array.filter(item => item.length > 0);
    }

    async _replaceVariables(part) {
        // 1. Arithmetic substitution $(( expr ))
        const arithMatches = [...part.matchAll(/\$\(\(([^)]+)\)\)/g)];
        for (const m of arithMatches) {
            part = part.replace(m[0], String(this._evalArithmetic(m[1])));
        }

        // 2. Command substitution $( cmd ) — negative lookahead excludes $((
        const cmdMatches = [...part.matchAll(/\$\((?!\()([^)]+)\)/g)];
        for (const m of cmdMatches) {
            const output = await this._runAndCapture(m[1]);
            part = part.replace(m[0], output);
        }

        // 3. Variable substitution $VAR and ${VAR}
        const matches = part.matchAll(variableRegex);
        let match = matches.next();
        while (!match.done) {
            const varName = match.value[1] || match.value[2];
            const value = this.context.getVar(varName);
            part = part.replace(new RegExp(Shell._escapeRegExp(match.value[0]), 'g'), String(value));
            match = matches.next();
        }

        return part;
    }

    _evalArithmetic(expr) {
        // First expand $VAR and ${VAR} references
        let expanded = expr.replace(/\${?([\w\d]+)}?/g, (m, name) =>
            String(parseInt(this.context.getVar(name)) || 0));
        // Then expand bare variable names (e.g. I in $((I+1)))
        expanded = expanded.replace(/\b([A-Za-z_]\w*)\b/g, (m, name) =>
            String(parseInt(this.context.getVar(name)) || 0));
        if (!/^[\d\s+\-*/%()]+$/.test(expanded.trim())) return 0;
        try {
            return new Function('return (' + expanded + ')')();
        } catch {
            return 0;
        }
    }

    async _runAndCapture(cmd) {
        const subshell = new globalThis.shell({
            cwd: this.context.fs.cwd,
            filesystem: this.context.fs.getRaw(),
            permissions: this.context.fs.getRawPermissions(),
            subshell: true
        });
        subshell.context.source(this.context);

        const lines = [];
        subshell.on('stdOut', line => lines.push(line));
        await subshell.onCommand(cmd, false);

        return lines.join('\n').trimEnd();
    }

    _groupPipes(segments) {
        const groups = [];
        let commands = [];
        for (const { command, op } of segments) {
            commands.push(command);
            if (op !== '|') {
                groups.push({ commands, op });
                commands = [];
            }
        }
        if (commands.length) groups.push({ commands, op: null });
        return groups;
    }

    async _runPipeChain(commands) {
        if (commands.length === 1) {
            return this._runCommand(commands[0]);
        }
        let stdinData = undefined;
        for (let i = 0; i < commands.length; i++) {
            const isLast = i === commands.length - 1;
            if (isLast) {
                if (stdinData !== undefined) this._stdin = stdinData;
                try {
                    await this._runCommand(commands[i]);
                } finally {
                    delete this._stdin;
                }
            } else {
                stdinData = await this._captureForPipe(commands[i], stdinData);
            }
        }
    }

    async _captureForPipe(cmd, stdin) {
        const subshell = new globalThis.shell({
            cwd: this.context.fs.cwd,
            filesystem: this.context.fs.getRaw(),
            permissions: this.context.fs.getRawPermissions(),
            subshell: true
        });
        subshell.context.source(this.context);
        if (stdin !== undefined) subshell.stdin = stdin;
        const lines = [];
        subshell.on('stdOut', line => lines.push(line));
        subshell.on('stdErr', line => this.emit('stdErr', line));
        await subshell.onCommand(cmd, false);
        this.lastCode = subshell.lastCode;
        return lines.join('\n');
    }

    // Returns Array<{value: string, hasQuote: boolean}>.
    // hasQuote=true means the token contained an explicit quoted segment (even empty ""),
    // which must be preserved even if the final value is an empty string.
    static _splitCommand(string) {
        const separator = /\s/g;
        let singleQuoteOpen = false;
        let doubleQuoteOpen = false;
        let dollarDepth = 0;
        let tokenBuffer = [];
        let tokenHasQuote = false;
        const parts = [];

        for (let i = 0; i < string.length; i++) {
            const ch = string[i];

            // Inside $(...) or $((...)) — keep everything verbatim, track nesting
            if (dollarDepth > 0) {
                tokenBuffer.push(ch);
                if (ch === '(') dollarDepth++;
                else if (ch === ')') dollarDepth--;
                continue;
            }

            // Quote handling
            if (ch === "'" && !doubleQuoteOpen) {
                singleQuoteOpen = !singleQuoteOpen;
                tokenHasQuote = true;
                continue;
            }
            if (ch === '"' && !singleQuoteOpen) {
                doubleQuoteOpen = !doubleQuoteOpen;
                tokenHasQuote = true;
                continue;
            }

            if (!singleQuoteOpen && !doubleQuoteOpen) {
                // Start of $( or $(( substitution — consume the opening '(' too
                if (ch === '$' && i + 1 < string.length && string[i + 1] === '(') {
                    dollarDepth = 1;
                    tokenBuffer.push('$');
                    tokenBuffer.push('(');
                    i++;
                    continue;
                }

                // Whitespace splits tokens
                if (ch.match(separator)) {
                    if (tokenBuffer.length > 0 || tokenHasQuote) {
                        parts.push({ value: tokenBuffer.join(''), hasQuote: tokenHasQuote });
                        tokenBuffer = [];
                        tokenHasQuote = false;
                    }
                    continue;
                }
            }

            tokenBuffer.push(ch);
        }

        if (tokenBuffer.length > 0 || tokenHasQuote) {
            parts.push({ value: tokenBuffer.join(''), hasQuote: tokenHasQuote });
        }

        if (singleQuoteOpen || doubleQuoteOpen) {
            throw new Error('quote expression not closed');
        }
        return parts;
    }

    _isWasmFile(path, content) {
        if (path.endsWith('.wasm') || path.endsWith('.wat')) return true;
        if (content instanceof Uint8Array) {
            return content.length >= 4 && content[0] === 0x00 && content[1] === 0x61 && content[2] === 0x73 && content[3] === 0x6d;
        }
        if (typeof content !== 'string') return false;
        // Binary WASM: magic bytes \0asm
        if (content.charCodeAt(0) === 0 && content.slice(1, 4) === 'asm') return true;
        // WAT text format
        return content.trimStart().startsWith('(module');
    }

    static _escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}

Shell.STATUS_READY = 'READY';
Shell.STATUS_WORKING = 'WORKING';
Shell.STATUS_DESTROYED = 'DESTROYED';

Shell.Command = Command;
Shell.InteractiveCommand = InteractiveCommand;
Shell.FS = BaseFileSystem;
Shell.BinaryContainer = require('./lib/BinaryContainer');
Shell.Storage = Shell.BinaryContainer.FilesystemStorage;

globalThis.shell = Shell;
module.exports = Shell;

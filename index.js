'use strict';

const Context = require('./lib/Context');
const LocalCommand = require('./lib/local/LocalCommand');
const ScriptCommand = require('./lib/ScriptCommand');
const WasmCommand = require('./lib/WasmCommand');
const JsCommand = require('./lib/JsCommand');
const Command = require('./lib/Command');
const InteractiveCommand = require('./lib/InteractiveCommand');
const { TtyStream } = require('./lib/TtyStream');

const HISTORY_FILE = '/.brsh_history';

const builtins = require('./lib/builtins');
const localCommands = require('./lib/local');
const events = require('events');
const BaseFileSystem = require('./lib/BaseFileSystem');

const BinaryContainer = require('./lib/BinaryContainer');
const { isAsyncFilesystemSource, resolveFilesystemSource } = BinaryContainer;

const variableRegex = /\$(?:\{([\w\d?#@*-]+)\}|([\w\d]+|[?#@*-]))/g;


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

        this.stdinStream = new TtyStream({ columns: 80, rows: 24 });
        this.stdout = new TtyStream({
            columns: 80,
            rows: 24,
            onWrite: (chunk) => this.emit('data', chunk)
        });
        this.stderr = new TtyStream({
            columns: 80,
            rows: 24,
            onWrite: (chunk) => this.emit('data', chunk)
        });

        this._lineBuffer = [];
        this._cursorPos = 0;
        this._history = [];
        this._historyPos = null;
        this._savedInput = null;
        this._historyLoaded = false;
        this._working = true;
        this._promptReady = false;
        this._inProgressLine = false;
        this._fromLineEditor = false;
        this._lastPromptRowOffset = 0;
        this._pendingCommands = [];

        if (!subshell) {
            this._setupTtyStreams();
        }

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

        if (this.context.fs && typeof this.context.fs.setTtyDevice === 'function') {
            this.context.fs.setTtyDevice({
                write: (chunk) => this.stdout.write(chunk),
                read: () => ''
            });
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
            if (this.context.fs && typeof this.context.fs.setTtyDevice === 'function') {
                this.context.fs.setTtyDevice({
                    write: (chunk) => this.stdout.write(chunk),
                    read: () => ''
                });
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

    get stdin() {
        return this._stdin !== undefined ? this._stdin : this.stdinStream;
    }

    set stdin(data) {
        this._stdin = data;
    }

    write(data) {
        this.stdinStream.pushData(data);
        return true;
    }

    resize(cols, rows) {
        this.setTerminalSize(cols, rows);
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
        this.stdinStream.resize(cols, rows);
        this.stdout.resize(cols, rows);
        this.stderr.resize(cols, rows);
        if (this.runningCommand) {
            if (this.runningCommand.stdinStream) this.runningCommand.stdinStream.resize(cols, rows);
            if (this.runningCommand.stdout) this.runningCommand.stdout.resize(cols, rows);
            if (this.runningCommand.stderr) this.runningCommand.stderr.resize(cols, rows);
        }
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
        if (events && !this._subshell && this._promptReady && !this._fromLineEditor) {
            this.stdout.write(`\r${this.getPrompt()} ${raw}\x1b[K\r\n`);
            this._lineBuffer = [];
            this._cursorPos = 0;
        }
        this._fromLineEditor = false;

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

        // Parse negation operator (!)
        let negate = false;
        while (args.length > 0 && !args[0].hasQuote && args[0].value === '!') {
            negate = !negate;
            args.shift();
        }

        if (!args.length) {
            this.lastCode = negate ? 1 : 0;
            this.emit('exitCode', this.lastCode);
            return;
        }

        // Parse file descriptor & stream redirections (> and >>, 1>, 2>, 2>&1, &>, etc.)
        // Quoted tokens (hasQuote: true) are never treated as redirects.
        let stdoutDest = { type: 'stdout' };
        let stderrDest = { type: 'stderr' };
        const positionalArgs = [];

        for (let i = 0; i < args.length; i++) {
            const { value: arg, hasQuote } = args[i];
            if (hasQuote) {
                positionalArgs.push(arg);
                continue;
            }

            // fd duplication / close
            if (arg === '2>&1') {
                stderrDest = { ...stdoutDest };
                continue;
            }
            if (arg === '1>&2') {
                stdoutDest = { ...stderrDest };
                continue;
            }
            if (arg === '2>&-') {
                stderrDest = { type: 'null' };
                continue;
            }
            if (arg === '1>&-' || arg === '>&-') {
                stdoutDest = { type: 'null' };
                continue;
            }

            // Both stdout & stderr redirect: &>, &>>, >&
            if (arg === '&>>') {
                if (i + 1 < args.length) {
                    const target = args[++i].value;
                    const dest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: true };
                    stdoutDest = dest;
                    stderrDest = dest;
                }
                continue;
            }
            if (arg === '&>' || arg === '>&') {
                if (i + 1 < args.length) {
                    const target = args[++i].value;
                    const dest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: false };
                    stdoutDest = dest;
                    stderrDest = dest;
                }
                continue;
            }
            if (arg.startsWith('&>>') && arg.length > 3) {
                const target = arg.slice(3);
                const dest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: true };
                stdoutDest = dest;
                stderrDest = dest;
                continue;
            }
            if ((arg.startsWith('&>') || arg.startsWith('>&')) && arg.length > 2) {
                const target = arg.slice(2);
                const dest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: false };
                stdoutDest = dest;
                stderrDest = dest;
                continue;
            }

            // Stderr redirect: 2>, 2>>
            if (arg === '2>>') {
                if (i + 1 < args.length) {
                    const target = args[++i].value;
                    stderrDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: true };
                }
                continue;
            }
            if (arg === '2>') {
                if (i + 1 < args.length) {
                    const target = args[++i].value;
                    stderrDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: false };
                }
                continue;
            }
            if (arg.startsWith('2>>') && arg.length > 3) {
                const target = arg.slice(3);
                stderrDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: true };
                continue;
            }
            if (arg.startsWith('2>') && arg.length > 2) {
                const target = arg.slice(2);
                stderrDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: false };
                continue;
            }

            // Stdout redirect: 1>, 1>>, >, >>
            if (arg === '1>>' || arg === '>>') {
                if (i + 1 < args.length) {
                    const target = args[++i].value;
                    stdoutDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: true };
                }
                continue;
            }
            if (arg === '1>' || arg === '>') {
                if (i + 1 < args.length) {
                    const target = args[++i].value;
                    stdoutDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: false };
                }
                continue;
            }
            if ((arg.startsWith('1>>') || arg.startsWith('>>')) && arg.length > (arg.startsWith('1>>') ? 3 : 2)) {
                const target = arg.slice(arg.startsWith('1>>') ? 3 : 2);
                stdoutDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: true };
                continue;
            }
            if ((arg.startsWith('1>') || arg.startsWith('>')) && arg.length > (arg.startsWith('1>') ? 2 : 1)) {
                const target = arg.slice(arg.startsWith('1>') ? 2 : 1);
                stdoutDest = target === '/dev/null' ? { type: 'null' } : { type: 'file', file: target, append: false };
                continue;
            }

            positionalArgs.push(arg);
        }

        if (!positionalArgs.length) {
            for (const dest of [stdoutDest, stderrDest]) {
                if (dest.type === 'file' && dest.file !== '/dev/null') {
                    try {
                        const abs = this.context.fs.absolutePath(dest.file);
                        const existing = this.context.fs._getFileRaw(abs);
                        if (!dest.append || existing === undefined) {
                            this.context.fs.setFileByPath(abs, existing || '', true);
                        }
                    } catch (e) {
                        this.emit('stdErr', `${dest.file}: Permission denied`);
                        this.lastCode = negate ? 0 : 1;
                        this.emit('exitCode', this.lastCode);
                        return;
                    }
                }
            }
            this.lastCode = negate ? 1 : 0;
            this.emit('exitCode', this.lastCode);
            return;
        }

        let bin = positionalArgs.shift();
        args = positionalArgs;

        // Bare variable assignment: VAR=value (only when no additional args)
        if (args.length === 0 && /^[A-Za-z_]\w*=/.test(bin)) {
            const eqIdx = bin.indexOf('=');
            this.context.setVar(bin.slice(0, eqIdx), bin.slice(eqIdx + 1));
            this.lastCode = negate ? 1 : 0;
            this.emit('exitCode', this.lastCode);
            return;
        }

        // Short circuit for aliases
        const alias = this.context.getAlias(bin);
        if(alias) {
            return this.onCommand(alias, false).then(() => {
                if (negate) {
                    this.lastCode = this.lastCode === 0 ? 1 : 0;
                    this.emit('exitCode', this.lastCode);
                }
            });
        }

        let Cmd;
        try {
            Cmd = this._parseCommand(
                (bin.startsWith('/') || bin.startsWith('./')) ? bin : bin.toLowerCase()
            );
        } catch(e) {
            this._handleCommandError(e.message, stderrDest, negate);
            return;
        }

        const isCommandClass = (C) => typeof C === 'function' && typeof C.prototype.run === 'function' && typeof C.prototype.runCommand === 'function';
        let instance;
        if(Cmd.prototype instanceof LocalCommand || new Cmd() instanceof ScriptCommand) {
            instance = new Cmd(args, this.context);
        } else if(isCommandClass(Cmd)) {
            instance = new Cmd(args, this._readonlyContext);
        } else {
            this._handleCommandError(`${bin}: Command not found`, stderrDest, negate);
            return;
        }

        if(instance.requiresFilesystem) {
            instance.fs = this.context.fs.sandbox();
        }

        if (this._stdin !== undefined) {
            instance.stdin = this._stdin;
        }

        const fileOutputs = new Map();
        const routeLine = ({ type, string }) => {
            const dest = type === 'out' ? stdoutDest : stderrDest;
            if (dest.type === 'stdout') {
                this.emit('stdOut', string);
            } else if (dest.type === 'stderr') {
                this.emit('stdErr', string);
            } else if (dest.type === 'file') {
                if (dest.file !== '/dev/null') {
                    let entry = fileOutputs.get(dest.file);
                    if (!entry) {
                        entry = { append: dest.append, lines: [] };
                        fileOutputs.set(dest.file, entry);
                    }
                    entry.lines.push(string);
                }
            }
        };

        this.runningCommand = instance;
        if(this.runningCommand.on) {
            this.runningCommand.on('flush', lines => {
                lines.forEach(routeLine);
            });
            this.runningCommand.on('stdout', chunk => {
                if (stdoutDest.type === 'file') {
                    if (!instance._streamedStdout) {
                        instance.stdOut = String(chunk ?? '');
                    }
                } else if (stdoutDest.type === 'stderr') {
                    this.stderr.write(chunk);
                } else if (stdoutDest.type === 'null') {
                    // discard
                } else {
                    this.stdout.write(chunk);
                    this.emit('stdOutRaw', chunk);
                }
            });
            this.runningCommand.on('token', token => {
                this.emit('token', token);
            });
            this.runningCommand.on('stderr', chunk => {
                if (stderrDest.type === 'file') {
                    instance.stdErr = String(chunk ?? '');
                } else if (stderrDest.type === 'stdout') {
                    if (stdoutDest.type === 'file') {
                        instance.stdOut = String(chunk ?? '');
                    } else if (stdoutDest.type === 'null') {
                        // discard
                    } else {
                        this.stdout.write(chunk);
                        this.emit('stdOutRaw', chunk);
                    }
                } else if (stderrDest.type === 'null') {
                    // discard
                } else {
                    this.stderr.write(chunk);
                }
            });
        }
        if (instance.interactive) {
            this.emit('interactive');
        }

        return instance.runCommand().then(result => {
            const stdOutput = result.getStdOutput();
            stdOutput.forEach(routeLine);

            for (const dest of [stdoutDest, stderrDest]) {
                if (dest.type === 'file' && dest.file !== '/dev/null' && !fileOutputs.has(dest.file)) {
                    fileOutputs.set(dest.file, { append: dest.append, lines: [] });
                }
            }

            for (const [filePath, { append, lines }] of fileOutputs) {
                const absTarget = this.context.fs.absolutePath(filePath);
                const content = lines.join('\n');
                let finalContent = content;
                if (append) {
                    const existing = this.context.fs._getFileRaw(absTarget);
                    finalContent = typeof existing === 'string'
                        ? (existing.length > 0 ? existing + '\n' + content : content)
                        : content;
                }
                try {
                    this.context.fs.setFileByPath(absTarget, finalContent, true);
                } catch (e) {
                    this.emit('stdErr', `${filePath}: Permission denied`);
                    this.lastCode = negate ? 0 : 1;
                    this.emit('exitCode', this.lastCode);
                    delete this.runningCommand;
                    return;
                }
            }

            const rawExitCode = result.getExitCode();
            this.lastCode = negate ? (rawExitCode === 0 ? 1 : 0) : rawExitCode;
            this.emit('exitCode', this.lastCode);
            delete this.runningCommand;
        });
    }

    _handleCommandError(message, stderrDest, negate) {
        if (stderrDest.type === 'stdout') {
            this.emit('stdOut', message);
        } else if (stderrDest.type === 'file') {
            if (stderrDest.file !== '/dev/null') {
                try {
                    const absTarget = this.context.fs.absolutePath(stderrDest.file);
                    const existing = this.context.fs._getFileRaw(absTarget);
                    const content = stderrDest.append && typeof existing === 'string'
                        ? (existing.length > 0 ? existing + '\n' + message : message)
                        : message;
                    this.context.fs.setFileByPath(absTarget, content, true);
                } catch (_) {}
            }
        } else if (stderrDest.type === 'stderr') {
            this.emit('stdErr', message);
        }
        this.lastCode = negate ? 0 : 1;
        this.emit('exitCode', this.lastCode);
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
        this.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        this.emit('clear');
    }

    _setupTtyStreams() {
        this.on('stdOut', line => {
            if (this.runningCommand && (this.runningCommand.interactive || this.runningCommand._inAltScreen || this.runningCommand._streamedStdout)) {
                if (this.runningCommand.interactive || this.runningCommand._inAltScreen) {
                    this.stdout.write(String(line ?? ''));
                }
                return;
            }
            if (typeof line === 'string' && line.startsWith('\r')) {
                this._inProgressLine = true;
                this.stdout.write('\r\x1b[K' + line.slice(1));
                return;
            }
            if (this._inProgressLine) {
                this.stdout.write('\r\n');
                this._inProgressLine = false;
            }
            this.stdout.write(String(line ?? '') + '\r\n');
        });

        this.on('stdErr', line => {
            if (this.runningCommand && (this.runningCommand.interactive || this.runningCommand._inAltScreen)) {
                return;
            }
            if (this._inProgressLine) {
                this.stdout.write('\r\n');
                this._inProgressLine = false;
            }
            this.stderr.write(String(line ?? '') + '\r\n');
        });

        this.on('status', status => {
            if (status === Shell.STATUS_READY) {
                if (this._inProgressLine) {
                    this.stdout.write('\r\n');
                    this._inProgressLine = false;
                }
                this._working = false;
                this._promptReady = true;
                if (!this._historyLoaded) {
                    this._loadHistory();
                    this._historyLoaded = true;
                }
                this._redrawPromptLine();
                if (this._pendingCommands.length > 0) {
                    const nextCmd = this._pendingCommands.shift();
                    if (this._pendingCommands.length === 0) {
                        const flags = this.context.getVar('-');
                        if (flags && flags.includes('c')) {
                            this.context.setVar('-', flags.replace(/c/g, ''));
                        }
                    }
                    this.sendCommand(nextCmd);
                }
            } else {
                this._working = true;
            }
        });

        this.stdinStream.on('data', data => this._handleStdinData(data));
        this.stdinStream.on('end', () => {
            if (!this.destroyed) this.destroy(0);
        });
    }

    sendCommand(command) {
        if (!this._promptReady) {
            this.suppressMotd();
            this._pendingCommands.push(command);
            return;
        }
        this.onCommand(command);
    }

    _redrawPromptLine() {
        if (this._working || (this.runningCommand && (this.runningCommand.interactive || this.runningCommand._inAltScreen))) {
            return;
        }
        const prompt = `${this.getPrompt()} `;
        const text = this._lineBuffer.join('');
        const cols = (this._terminalSize && this._terminalSize.cols) || 80;
        const prevRowOffset = this._lastPromptRowOffset || 0;

        let seq = '';
        if (prevRowOffset > 0) {
            seq += `\x1b[${prevRowOffset}A`;
        }
        seq += `\r\x1b[J${prompt}${text}`;

        const pos = Math.min(this._cursorPos, this._lineBuffer.length);
        const endPos = prompt.length + this._lineBuffer.length;
        const targetPos = prompt.length + pos;

        const endRowOffset = Math.floor(endPos / cols);
        const targetRowOffset = Math.floor(targetPos / cols);
        const targetCol = targetPos % cols;

        if (endRowOffset > targetRowOffset) {
            seq += `\x1b[${endRowOffset - targetRowOffset}A\r`;
            if (targetCol > 0) {
                seq += `\x1b[${targetCol}C`;
            }
        } else if (endPos > targetPos) {
            const diff = endPos - targetPos;
            seq += `\x1b[${diff}D`;
        }

        this._lastPromptRowOffset = targetRowOffset;
        this.stdout.write(seq);
    }

    _loadHistory() {
        try {
            const file = this.context.fs._getFileRaw(HISTORY_FILE);
            if (file && typeof file === 'string' && file.length > 0) {
                this._history = file.split('\n').filter(l => l.length > 0);
            }
        } catch (e) {
            // No history file yet
        }
    }

    _saveHistory() {
        try {
            this.context.fs._setFileRaw(HISTORY_FILE, this._history.join('\n'), true);
        } catch (e) {
            // Ignore persistence errors
        }
    }

    _navigateHistory(direction) {
        if (this._history.length === 0) return;
        if (direction === -1) {
            if (this._historyPos === null) {
                this._savedInput = [...this._lineBuffer];
                this._historyPos = this._history.length - 1;
            } else if (this._historyPos > 0) {
                this._historyPos--;
            } else {
                return;
            }
            this._lineBuffer = Array.from(this._history[this._historyPos]);
        } else {
            if (this._historyPos === null) return;
            if (this._historyPos < this._history.length - 1) {
                this._historyPos++;
                this._lineBuffer = Array.from(this._history[this._historyPos]);
            } else {
                this._historyPos = null;
                this._lineBuffer = this._savedInput ? [...this._savedInput] : [];
                this._savedInput = null;
            }
        }
        this._cursorPos = this._lineBuffer.length;
        this._redrawPromptLine();
    }

    _wordLeft() {
        let pos = this._cursorPos;
        while (pos > 0 && this._lineBuffer[pos - 1] === ' ') pos--;
        while (pos > 0 && this._lineBuffer[pos - 1] !== ' ') pos--;
        return pos;
    }

    _wordRight() {
        let pos = this._cursorPos;
        const len = this._lineBuffer.length;
        while (pos < len && this._lineBuffer[pos] === ' ') pos++;
        while (pos < len && this._lineBuffer[pos] !== ' ') pos++;
        return pos;
    }

    _handleStdinData(raw) {
        const data = typeof raw === 'string'
            ? raw
            : (raw instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)))
                ? new TextDecoder().decode(raw)
                : String(raw ?? '');

        if (this.runningCommand) {
            const cmd = this.runningCommand;
            const isCtrlC = (typeof raw === 'string' && raw === '\x03')
                || (raw instanceof Uint8Array && raw.length === 1 && raw[0] === 3)
                || ((typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) && raw.length === 1 && raw[0] === 3);

            if (isCtrlC && (!cmd.stdinStream || !cmd.stdinStream.isRaw)) {
                if (typeof cmd.kill === 'function') {
                    cmd.kill('SIGINT');
                }
                if (!cmd.interactive && !cmd._inAltScreen) {
                    this.stdout.write('^C\r\n');
                }
                return;
            }

            const hasStreamListeners = cmd.stdinStream && cmd.stdinStream.listenerCount('data') > 1;
            if (cmd.captureInput || cmd.interactive || cmd._inAltScreen || hasStreamListeners) {
                cmd.stdinStream.pushData(raw);
                return;
            }
        }

        if (this._working) return;

        let i = 0;
        while (i < data.length) {
            const ch = data[i];
            const code = data.charCodeAt(i);

            if (code === 0x1b) {
                if (data[i + 1] === 'b') {
                    this._cursorPos = this._wordLeft();
                    this._redrawPromptLine();
                    i += 2;
                    continue;
                }
                if (data[i + 1] === 'f') {
                    this._cursorPos = this._wordRight();
                    this._redrawPromptLine();
                    i += 2;
                    continue;
                }
                if (data.charCodeAt(i + 1) === 0x7f || data.charCodeAt(i + 1) === 0x08) {
                    const target = this._wordLeft();
                    this._lineBuffer.splice(target, this._cursorPos - target);
                    this._cursorPos = target;
                    this._redrawPromptLine();
                    i += 2;
                    continue;
                }
                if (data[i + 1] === 'd') {
                    const target = this._wordRight();
                    this._lineBuffer.splice(this._cursorPos, target - this._cursorPos);
                    this._redrawPromptLine();
                    i += 2;
                    continue;
                }
                if (data[i + 1] === '[' || data[i + 1] === 'O') {
                    let j = i + 2;
                    while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) {
                        j++;
                    }
                    if (j < data.length) {
                        this._handleEscapeSeq(data.slice(i + 2, j + 1));
                        i = j + 1;
                        continue;
                    }
                }
                i++;
                continue;
            }

            if (code === 0x04) {
                if (this._lineBuffer.length === 0) {
                    this.stdout.write('exit\r\n');
                    this.destroy(0);
                    return;
                }
                if (this._cursorPos < this._lineBuffer.length) {
                    this._lineBuffer.splice(this._cursorPos, 1);
                    this._redrawPromptLine();
                }
                i++;
                continue;
            }

            if (code === 0x0d || code === 0x0a) {
                const command = this._lineBuffer.join('');
                this._lineBuffer = [];
                this._cursorPos = 0;
                this._historyPos = null;
                this._savedInput = null;
                this.stdout.write('\r\n');

                if (command.trim()) {
                    if (this._history[this._history.length - 1] !== command) {
                        this._history.push(command);
                    }
                    this._saveHistory();
                }

                this._fromLineEditor = true;
                this.onCommand(command);
                if (code === 0x0d && data[i + 1] === '\n') i++;
                i++;
                continue;
            }

            if (code === 0x7f || code === 0x08) {
                if (this._cursorPos > 0) {
                    this._lineBuffer.splice(this._cursorPos - 1, 1);
                    this._cursorPos--;
                    this._redrawPromptLine();
                }
                i++;
                continue;
            }

            if (code === 0x09) {
                this._handleTab();
                i++;
                continue;
            }

            if (code === 0x01) {
                this._cursorPos = 0;
                this._redrawPromptLine();
                i++;
                continue;
            }
            if (code === 0x05) {
                this._cursorPos = this._lineBuffer.length;
                this._redrawPromptLine();
                i++;
                continue;
            }
            if (code === 0x15) {
                this._lineBuffer.splice(0, this._cursorPos);
                this._cursorPos = 0;
                this._redrawPromptLine();
                i++;
                continue;
            }
            if (code === 0x0b) {
                this._lineBuffer.splice(this._cursorPos);
                this._redrawPromptLine();
                i++;
                continue;
            }
            if (code === 0x17) {
                const target = this._wordLeft();
                this._lineBuffer.splice(target, this._cursorPos - target);
                this._cursorPos = target;
                this._redrawPromptLine();
                i++;
                continue;
            }
            if (code === 0x0c) {
                this.stdout.write('\x1b[2J\x1b[H');
                this._redrawPromptLine();
                i++;
                continue;
            }
            if (code === 0x03) {
                this._lineBuffer = [];
                this._cursorPos = 0;
                this._historyPos = null;
                this._savedInput = null;
                this.stdout.write('^C\r\n');
                this._redrawPromptLine();
                i++;
                continue;
            }

            if (code >= 0x20) {
                this._lineBuffer.splice(this._cursorPos, 0, ch);
                this._cursorPos++;
                this._redrawPromptLine();
            }
            i++;
        }
    }

    _handleEscapeSeq(seq) {
        if (seq === 'A') {
            this._navigateHistory(-1);
        } else if (seq === 'B') {
            this._navigateHistory(1);
        } else if (seq === 'C') {
            if (this._cursorPos < this._lineBuffer.length) {
                this._cursorPos++;
                this._redrawPromptLine();
            }
        } else if (seq === 'D') {
            if (this._cursorPos > 0) {
                this._cursorPos--;
                this._redrawPromptLine();
            }
        } else if (seq === '1;3D' || seq === '1;5D') {
            this._cursorPos = this._wordLeft();
            this._redrawPromptLine();
        } else if (seq === '1;3C' || seq === '1;5C') {
            this._cursorPos = this._wordRight();
            this._redrawPromptLine();
        } else if (seq === 'H' || seq === '1~' || seq === '7~') {
            this._cursorPos = 0;
            this._redrawPromptLine();
        } else if (seq === 'F' || seq === '4~' || seq === '8~') {
            this._cursorPos = this._lineBuffer.length;
            this._redrawPromptLine();
        } else if (seq === '3~') {
            if (this._cursorPos < this._lineBuffer.length) {
                this._lineBuffer.splice(this._cursorPos, 1);
                this._redrawPromptLine();
            }
        }
    }

    _handleTab() {
        const commandParts = this._lineBuffer.join('').split(' ');
        const lastPath = commandParts.pop();
        const autoComplete = this.tabCompletion(lastPath);
        if (!autoComplete) return;

        const { options, path } = autoComplete;
        if (options.length === 1) {
            commandParts.push(`${path != null ? path.concat('/') : ''}${options[0]}`);
            this._lineBuffer = commandParts.join(' ').split('');
            this._cursorPos = this._lineBuffer.length;
            this._redrawPromptLine();
        } else if (options.length > 1) {
            this.stdout.write('\r\n' + options.join('  ') + '\r\n');
            this._redrawPromptLine();
        }
    }

    _splitInput(input) {
        return this._parseOperators(input);
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
                if (ch === '#' && (current.trim() === '' || /\s/.test(input[i - 1]))) {
                    const nextNewline = input.indexOf('\n', i);
                    if (nextNewline === -1) {
                        break;
                    }
                    i = nextNewline;
                    continue;
                }
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

    _loadJsCommand(scriptPath, content) {
        if (!this._jsCommandCache) {
            this._jsCommandCache = new Map();
        }
        return JsCommand.load(this.context.fs, scriptPath, content, this._jsCommandCache);
    }

    _resolveCommandFromPath(binLocation) {
        let targetPath = binLocation;
        while (this.context.fs.isSymlink(targetPath)) {
            const link = this.context.fs.readSymlink(targetPath);
            targetPath = link.startsWith('/')
                ? this.context.fs.absolutePath(link)
                : this.context.fs.absolutePath(`${targetPath.split('/').slice(0, -1).join('/')}/${link}`);
        }

        if (!this.context.fs.isExecutable(binLocation) && !this.context.fs.isExecutable(targetPath)) {
            throw new Error(`${binLocation}: permission denied`);
        }

        const handle = this.context.fs.getFileByPath(targetPath);
        const binName = binLocation.split('/').pop().replace(/\.(wasm|wat|js)$/i, '').toLowerCase();

        if (typeof handle === 'function') {
            if (handle.prototype && typeof handle.prototype.run === 'function' && typeof handle.prototype.runCommand === 'function') {
                return handle;
            }
            return this._loadJsCommand(targetPath, handle);
        }

        if (typeof handle === 'string' && handle.startsWith('#!')) {
            return ScriptCommand.bind(this, handle);
        }

        if (this._isWasmFile(targetPath, handle)) {
            let pkgMeta = null;
            try {
                const dirParts = targetPath.split('/').filter(Boolean);
                dirParts.pop();
                const pkgJsonPath = '/' + dirParts.join('/') + '/package.json';
                if (this.context.fs.exists(pkgJsonPath)) {
                    const rawJson = this.context.fs.getFileByPath(pkgJsonPath);
                    if (typeof rawJson === 'string') {
                        pkgMeta = JSON.parse(rawJson);
                    }
                }
            } catch (_) {}

            class ExecutableWasmCommand extends WasmCommand {
                static get name() { return binName; }
                get name() { return binName; }
                get requiresFilesystem() { return true; }
                constructor(args, context) {
                    super(targetPath, args, context);
                    this.script = targetPath;
                    this.arguments = args || [];
                    this.context = context || null;
                    if (context && context.fs && !this.fs) {
                        this.fs = context.fs;
                    }
                    if (pkgMeta) {
                        this._pkgMeta = pkgMeta;
                    }
                }
            }
            return ExecutableWasmCommand;
        }

        if (targetPath.endsWith('.js') || (typeof handle === 'string' && (handle.includes('export') || handle.includes('module.exports')))) {
            const Loaded = this._loadJsCommand(targetPath, handle);
            if (Loaded && Loaded.name !== binName) {
                class AliasedCommand extends Loaded {
                    static get name() { return binName; }
                    get name() { return binName; }
                }
                return AliasedCommand;
            }
            return Loaded;
        }

        return null;
    }

    _parseCommand(command) {
        if(command.startsWith('./') || command.startsWith('/') || command.startsWith('../') || command.includes('/')) {
            let absPath = this.context.fs.absolutePath(command);
            if(!this.context.fs.exists(absPath)) {
                if (!command.endsWith('.wasm') && this.context.fs.exists(`${absPath}.wasm`)) {
                    absPath = `${absPath}.wasm`;
                } else if (!command.endsWith('.js') && this.context.fs.exists(`${absPath}.js`)) {
                    absPath = `${absPath}.js`;
                } else {
                    throw new Error(`${command}: No such file or directory`);
                }
            }

            const stat = this.context.fs.stat(absPath);
            if (stat && stat.isDirectory) {
                throw new Error(`${command}: is a directory`);
            }

            const cmd = this._resolveCommandFromPath(absPath);
            if (!cmd) {
                throw new Error(`${command}: permission denied`);
            }
            return cmd;
        }

        // 1. Built-in registered commands take precedence (mkdir, echo, cat, etc.)
        let builtin = this.context.getCommand(command);
        if (!builtin && !command.endsWith('.wasm')) {
            builtin = this.context.getCommand(`${command}.wasm`);
        }
        if (!builtin && !command.endsWith('.js')) {
            builtin = this.context.getCommand(`${command}.js`);
        }
        if (typeof builtin === 'function' && builtin.prototype && typeof builtin.prototype.run === 'function') {
            return builtin;
        }
        if (typeof builtin === 'string' && builtin.startsWith('#!')) {
            return ScriptCommand.bind(this, builtin);
        }

        // 2. Search PATH directories for installed binaries, symlinks, scripts, and wasm
        const pathDirs = (this.context.getVar('PATH') || '/bin').split(':').filter(Boolean);
        for (const dir of pathDirs) {
            let binLocation = `${dir}/${command}`;
            if (!this.context.fs.exists(binLocation)) {
                if (!command.endsWith('.wasm') && this.context.fs.exists(`${binLocation}.wasm`)) {
                    binLocation = `${binLocation}.wasm`;
                } else if (!command.endsWith('.js') && this.context.fs.exists(`${binLocation}.js`)) {
                    binLocation = `${binLocation}.js`;
                }
            }

            if (this.context.fs.exists(binLocation)) {
                const cmd = this._resolveCommandFromPath(binLocation);
                if (cmd) return cmd;
            }
        }

        throw new Error(`${command}: Command not found`);
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

        let negatePipeline = false;
        try {
            const firstParts = Shell._splitCommand(commands[0]);
            let strippedCmd0 = commands[0];
            let hasNegation = false;
            while (firstParts.length > 0 && !firstParts[0].hasQuote && firstParts[0].value === '!') {
                negatePipeline = !negatePipeline;
                hasNegation = true;
                firstParts.shift();
                strippedCmd0 = strippedCmd0.replace(/^\s*!\s*/, '');
            }
            if (hasNegation) {
                commands = [strippedCmd0, ...commands.slice(1)];
            }
        } catch (_) {}

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

        if (negatePipeline) {
            this.lastCode = this.lastCode === 0 ? 1 : 0;
            this.emit('exitCode', this.lastCode);
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

            // Escape handling inside double quotes
            if (doubleQuoteOpen && ch === '\\' && i + 1 < string.length) {
                const next = string[i + 1];
                if (next === '"' || next === '\\' || next === '$') {
                    tokenBuffer.push(next);
                    i++;
                    continue;
                }
            }

            // Escape handling outside quotes
            if (!singleQuoteOpen && !doubleQuoteOpen && ch === '\\' && i + 1 < string.length) {
                const next = string[++i];
                tokenBuffer.push(next);
                if (next === '"' || next === "'") {
                    tokenHasQuote = true;
                }
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

    /**
     * Asynchronously creates and boots a Shell instance.
     * Pre-resolves any async filesystem sources (URLs, Promises, .brfs containers, or IndexedDB)
     * before returning the fully initialized shell.
     */
    static async create(options = {}) {
        let { filesystem, permissions, ...rest } = options;
        if (isAsyncFilesystemSource(filesystem) || (filesystem && typeof filesystem === 'object' && isAsyncFilesystemSource(filesystem.filesystem))) {
            const resolved = await resolveFilesystemSource(filesystem, permissions);
            filesystem = resolved.filesystem;
            permissions = resolved.permissions;
        }
        const shell = new Shell(Object.assign({}, rest, { filesystem, permissions }));
        await shell.ready;
        return shell;
    }

    /**
     * Helper to create a Shell directly from a .brfs container (URL, Uint8Array, or Promise).
     */
    static async fromContainer(source, options = {}) {
        return Shell.create(Object.assign({}, options, { filesystem: source }));
    }
}

Shell.STATUS_READY = 'READY';
Shell.STATUS_WORKING = 'WORKING';
Shell.STATUS_DESTROYED = 'DESTROYED';

Shell.Command = Command;
Shell.InteractiveCommand = InteractiveCommand;
Shell.WasmCommand = WasmCommand;
Shell.createWasmCommand = WasmCommand.createGenericWasmCommand || WasmCommand.createCommand;
Shell.ReplCommand = require('./lib/ReplCommand');
Shell.JsCommand = JsCommand;
Shell.FS = BaseFileSystem;
Shell.BinaryContainer = require('./lib/BinaryContainer');
Shell.Storage = Shell.BinaryContainer.FilesystemStorage;

globalThis.shell = Shell;
globalThis.Shell = Shell;
module.exports = Shell;

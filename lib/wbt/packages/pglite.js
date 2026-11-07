'use strict';

const Command = require('../../Command');
const ReplCommand = require('../ReplCommand');
const { formatTable, formatPipeList, formatCsv, loadModule } = require('../utils');
const { daemonManager } = require('../daemon');

// Shared in-memory PGlite instances keyed by virtual dataDir path so state persists across invocations
const pgliteInstances = new Map();

/**
 * Helper to initialize or retrieve a PGlite instance for a given dataDir and filesystem.
 */
async function getOrInitPgliteInstance(rawDir, fs, pkgMeta, wbtConfig = {}) {
    const mod = await loadModule('@electric-sql/pglite', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
    const PGlite = mod.PGlite || mod.default || mod;

    if (!rawDir || rawDir === 'memory://' || rawDir === ':memory:') {
        const pg = typeof PGlite.create === 'function' ? await PGlite.create() : new PGlite();
        if (pg.waitReady) await pg.waitReady;
        return { pg, isEphemeral: true, absDir: null };
    }

    const absDir = fs.absolutePath(rawDir);
    if (pgliteInstances.has(absDir)) {
        return { pg: pgliteInstances.get(absDir), isEphemeral: false, absDir };
    }

    if (fs.isRealFilesystem) {
        const nodeFs = require('fs');
        nodeFs.mkdirSync(absDir, { recursive: true });
        const pg = typeof PGlite.create === 'function' ? await PGlite.create(absDir) : new PGlite(absDir);
        if (pg.waitReady) await pg.waitReady;
        pgliteInstances.set(absDir, pg);
        return { pg, isEphemeral: false, absDir };
    }

    // Virtual filesystem: create directory marker + replay journal if present
    if (!fs.exists(absDir)) {
        fs.setFileByPath(absDir, {}, true);
    }
    const journalPath = `${absDir}/wal.sql`;
    const pg = typeof PGlite.create === 'function' ? await PGlite.create() : new PGlite();
    if (pg.waitReady) await pg.waitReady;

    const existingWal = fs.getFileByPath(journalPath);
    if (typeof existingWal === 'string' && existingWal.trim()) {
        try {
            await pg.exec(existingWal);
        } catch {
            // ignore replay errors
        }
    }
    pgliteInstances.set(absDir, pg);
    return { pg, isEphemeral: false, absDir };
}

function appendVirtualWal(fs, absDir, isEphemeral, sqlText) {
    if (isEphemeral || !absDir || !fs || fs.isRealFilesystem) return;
    if (!/\b(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(sqlText)) return;
    try {
        const journalPath = `${absDir}/wal.sql`;
        const existing = fs.getFileByPath(journalPath);
        const normalized = sqlText.trim().endsWith(';') ? sqlText.trim() : sqlText.trim() + ';';
        const updated = typeof existing === 'string' && existing.length > 0
            ? `${existing}\n${normalized}`
            : normalized;
        fs.setFileByPath(journalPath, updated, true);
    } catch {
        // ignore
    }
}

/**
 * Starts a PGlite background server daemon on `port` (default 5432) via DaemonManager.
 * Exposes HTTP endpoints (`GET /status`, `POST /query`, `POST /sql`, `GET /query?sql=...`)
 * so `curl http://localhost:5432/query -d "SELECT 1"`, `psql -h localhost -p 5432`, and browser `fetch()`
 * all talk to the live PGlite daemon!
 */
async function startPgliteDaemon({ dataDir = '/var/lib/postgresql/data', port = 5432, host = '127.0.0.1', fs, pkgMeta, wbtConfig }) {
    const { pg, isEphemeral, absDir } = await getOrInitPgliteInstance(dataDir, fs, pkgMeta, wbtConfig);
    const pidFile = `${absDir || '/var/run'}/postmaster.pid`;

    const daemon = await daemonManager.startDaemon({
        name: 'pglite',
        port: Number(port),
        host,
        dataDir: absDir || dataDir,
        instance: pg,
        fs,
        pidFile,
        handler: async (req) => {
            if (req.path === '/status' || req.path === '/health') {
                return {
                    status: 200,
                    body: {
                        status: 'ready',
                        engine: 'pglite',
                        version: pkgMeta.version,
                        port: Number(port),
                        dataDir: absDir || dataDir
                    }
                };
            }

            let sql = req.searchParams ? req.searchParams.get('sql') : null;
            if (!sql && req.body) {
                const trimmedBody = req.body.trim();
                if (trimmedBody.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(trimmedBody);
                        sql = parsed.query || parsed.sql || '';
                    } catch {
                        sql = trimmedBody;
                    }
                } else {
                    sql = trimmedBody;
                }
            }

            if (!sql) {
                return {
                    status: 400,
                    body: { error: 'No SQL query provided. Pass SQL in POST body or ?sql= query param.' }
                };
            }

            try {
                const rawRes = typeof pg.exec === 'function' ? await pg.exec(sql) : [await pg.query(sql)];
                appendVirtualWal(fs, absDir, isEphemeral, sql);
                const resList = Array.isArray(rawRes) ? rawRes : [rawRes];
                const last = resList[resList.length - 1] || { fields: [], rows: [] };
                return {
                    status: 200,
                    body: {
                        fields: (last.fields || []).map(f => typeof f === 'string' ? f : f.name),
                        rows: last.rows || [],
                        affectedRows: last.affectedRows ?? 0,
                        results: resList
                    }
                };
            } catch (err) {
                return {
                    status: 400,
                    body: { error: err.message || String(err) }
                };
            }
        }
    });

    return daemon;
}

function createPgliteCommand(pkgMeta, wbtConfig = {}, binName = 'pglite') {
    class PgliteCommand extends ReplCommand {
        static get name() { return binName; }
        get name() { return binName; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
            this._pg = null;
            this._mode = this._parsed.mode || 'table';
        }

        _parseArgs(args) {
            let dataDir = null;
            let sql = null;
            let file = null;
            let mode = 'table';
            let tuplesOnly = false;
            let help = false;
            let version = false;
            let daemonAction = null; // 'start' | 'stop' | 'status'
            let host = null;
            let port = 5432;

            const positional = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--help' || arg === '-h' && i + 1 >= args.length || arg === '-?') {
                    help = true;
                } else if (arg === '--version' || arg === '-V' || arg === '-v') {
                    version = true;
                } else if (arg === '--serve' || arg === '--daemon') {
                    daemonAction = 'start';
                } else if ((arg === '-p' || arg === '--port') && i + 1 < args.length) {
                    port = Number(args[++i]) || 5432;
                } else if (arg.startsWith('--port=')) {
                    port = Number(arg.slice('--port='.length)) || 5432;
                } else if ((arg === '-h' || arg === '--host') && i + 1 < args.length) {
                    host = args[++i];
                } else if ((arg === '-c' || arg === '--command') && i + 1 < args.length) {
                    sql = args[++i];
                } else if ((arg === '-f' || arg === '--file') && i + 1 < args.length) {
                    file = args[++i];
                } else if ((arg === '-d' || arg === '--dbname' || arg === '-D' || arg === '--pgdata') && i + 1 < args.length) {
                    dataDir = args[++i];
                } else if (arg === '-t' || arg === '--tuples-only' || arg === '-A' || arg === '--no-align') {
                    tuplesOnly = true;
                    mode = 'list';
                } else if (arg === '--csv') {
                    mode = 'csv';
                } else if (arg === '--json') {
                    mode = 'json';
                } else if (!arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            // Support subcommands: `pglite serve`, `pglite start`, `pglite stop`, `pglite status`
            if (positional.length > 0 && ['serve', 'start', 'stop', 'status'].includes(positional[0].toLowerCase())) {
                const sub = positional.shift().toLowerCase();
                daemonAction = sub === 'serve' ? 'start' : sub;
            }

            if (positional.length === 1) {
                if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|BEGIN|SHOW|SET|EXPLAIN|VALUES|\\)\b/i.test(positional[0])) {
                    sql = positional[0];
                } else {
                    dataDir = positional[0];
                }
            } else if (positional.length >= 2) {
                dataDir = positional[0];
                sql = positional.slice(1).join(' ');
            }

            // Check if a PGlite daemon is already running on `port` when no explicit dataDir was given
            const runningDaemon = daemonManager.getDaemon(port);
            const useDaemon = Boolean(host || (runningDaemon && !dataDir));

            return {
                dataDir: dataDir || (runningDaemon ? runningDaemon.dataDir : 'memory://'),
                sql,
                file,
                mode,
                tuplesOnly,
                help,
                version,
                daemonAction,
                host: host || '127.0.0.1',
                port,
                useDaemon
            };
        }

        shouldBeInteractive() {
            if (this._parsed.help || this._parsed.version || this._parsed.daemonAction) return false;
            if (this._parsed.sql !== null || this._parsed.file !== null) return false;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) return false;
            return true;
        }

        getReplTitle() {
            const daemon = daemonManager.getDaemon(this._parsed.port);
            const target = daemon
                ? `daemon://${daemon.host}:${daemon.port} (${daemon.dataDir})`
                : this._parsed.dataDir;
            return `PGlite PostgreSQL WASM (${pkgMeta.version}) — ${target}`;
        }

        getReplPrompt() {
            return 'postgres=# ';
        }

        getReplWelcome() {
            const daemon = daemonManager.getDaemon(this._parsed.port);
            return [
                `psql (PGlite ${pkgMeta.version}, PostgreSQL 16.4 WASM)`,
                daemon
                    ? `Connected to running PGlite daemon on ${daemon.host}:${daemon.port} (PID ${daemon.pid})`
                    : `Data directory: ${this._parsed.dataDir}`,
                `Type "\\?" for help, "\\dt" to list tables, "\\q" or ".exit" to quit.`
            ];
        }

        async _initPg() {
            const daemon = daemonManager.getDaemon(this._parsed.port);
            if (daemon && (this._parsed.useDaemon || daemon.dataDir === this.fs.absolutePath(this._parsed.dataDir))) {
                this._pg = daemon.instance;
                this._absDataDir = daemon.dataDir;
                this._isEphemeral = false;
                return;
            }

            const { pg, isEphemeral, absDir } = await getOrInitPgliteInstance(
                this._parsed.dataDir,
                this.fs,
                pkgMeta,
                wbtConfig
            );
            this._pg = pg;
            this._isEphemeral = isEphemeral;
            this._absDataDir = absDir;
        }

        async _executeQuery(sqlText) {
            const outLines = [];
            const trimmed = sqlText.trim();
            if (!trimmed) return outLines;

            if (trimmed.startsWith('\\')) {
                const parts = trimmed.split(/\s+/);
                const cmd = parts[0];
                if (cmd === '\\?' || cmd === '\\help') {
                    return [
                        'General:',
                        '  \\dt             list tables in public schema',
                        '  \\d [NAME]       describe table, view, or index',
                        '  \\l              list databases',
                        '  \\i FILE         execute commands from file',
                        '  \\q              quit pglite'
                    ];
                }
                if (cmd === '\\dt') {
                    return this._executeQuery(
                        "SELECT schemaname AS schema, tablename AS name, tableowner AS owner FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2;"
                    );
                }
                if (cmd === '\\l') {
                    return this._executeQuery(
                        "SELECT datname AS name, pg_catalog.pg_encoding_to_char(encoding) AS encoding FROM pg_catalog.pg_database;"
                    );
                }
                if (cmd === '\\d') {
                    if (!parts[1]) {
                        return this._executeQuery(
                            "SELECT table_schema AS schema, table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2;"
                        );
                    }
                    const tbl = parts[1].replace(/'/g, "''");
                    return this._executeQuery(
                        `SELECT column_name AS column, data_type AS type, is_nullable AS nullable, column_default AS default FROM information_schema.columns WHERE table_name = '${tbl}' ORDER BY ordinal_position;`
                    );
                }
                if (cmd === '\\i' && parts[1]) {
                    const fileContent = this.fs.getFileByPath(parts[1]);
                    if (fileContent == null) {
                        throw new Error(`${parts[1]}: No such file or directory`);
                    }
                    return this._executeQuery(String(fileContent));
                }
                throw new Error(`invalid command ${cmd}. Try \\? for help.`);
            }

            const results = typeof this._pg.exec === 'function'
                ? await this._pg.exec(sqlText)
                : [await this._pg.query(sqlText)];

            appendVirtualWal(this.fs, this._absDataDir, this._isEphemeral, sqlText);

            const resArray = Array.isArray(results) ? results : [results];
            for (const res of resArray) {
                if (!res) continue;
                const fields = (res.fields || []).map(f => typeof f === 'string' ? f : f.name);
                const rows = res.rows || [];

                if (fields.length === 0) {
                    if (typeof res.affectedRows === 'number') {
                        outLines.push(`OK (${res.affectedRows})`);
                    }
                    continue;
                }

                if (this._mode === 'list') {
                    outLines.push(...formatPipeList(fields, rows, false));
                } else if (this._mode === 'csv') {
                    outLines.push(...formatCsv(fields, rows, true));
                } else if (this._mode === 'json') {
                    outLines.push(JSON.stringify(rows));
                } else {
                    outLines.push(...formatTable(fields, rows, { showRowCount: true }));
                }
            }
            return outLines;
        }

        async initRepl() {
            await this._initPg();
        }

        async evaluateReplLine(line) {
            try {
                const output = await this._executeQuery(line);
                return { output };
            } catch (err) {
                return { error: `ERROR:  ${err.message || err}` };
            }
        }

        async cleanupRepl() {
            if (this._isEphemeral && this._pg && typeof this._pg.close === 'function') {
                try { await this._pg.close(); } catch { /* ignore */ }
            }
        }

        async _handleDaemonAction() {
            const action = this._parsed.daemonAction;
            const port = this._parsed.port || 5432;
            const dataDir = this._parsed.dataDir === 'memory://' ? '/var/lib/postgresql/data' : this._parsed.dataDir;

            if (action === 'start') {
                try {
                    const entry = await startPgliteDaemon({
                        dataDir,
                        port,
                        host: this._parsed.host,
                        fs: this.fs,
                        pkgMeta,
                        wbtConfig
                    });
                    this.stdOut = `waiting for server to start.... done`;
                    this.stdOut = `server started (PID ${entry.pid}) listening on http://${entry.host}:${entry.port} (dataDir: ${entry.dataDir})`;
                } catch (err) {
                    this.stdErr = `pglite: could not start server: ${err.message || err}`;
                    this.exitCode = 1;
                }
                return;
            }

            if (action === 'stop') {
                const stopped = await daemonManager.stopDaemon(port) || await daemonManager.stopDaemon('pglite');
                if (!stopped) {
                    this.stdErr = `pglite: no server running on port ${port}`;
                    this.exitCode = 1;
                    return;
                }
                this.stdOut = `waiting for server to shut down.... done`;
                this.stdOut = `server stopped (PID ${stopped.pid})`;
                return;
            }

            if (action === 'status') {
                const running = daemonManager.getDaemon(port) || daemonManager.getDaemon('pglite');
                if (!running) {
                    this.stdOut = `pglite: no server running`;
                    this.exitCode = 3;
                    return;
                }
                this.stdOut = `pglite server is running (PID: ${running.pid}, port: ${running.port}, dataDir: ${running.dataDir})`;
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    `Usage: ${binName} [OPTIONS] [DATADIR] [SQL]`,
                    '       pglite serve [-D DATADIR] [-p PORT]   Start PGlite background daemon',
                    '       pglite status [-p PORT]               Check daemon status',
                    '       pglite stop [-p PORT]                 Stop running daemon',
                    '',
                    'Options:',
                    '  -c, --command=SQL    run only single command (SQL or internal) and exit',
                    '  -f, --file=FILENAME  execute commands from file, then exit',
                    '  -d, -D, --pgdata=DIR database storage directory in filesystem',
                    '  --serve, --daemon    start PGlite server daemon in the background',
                    '  -h, --host=HOSTNAME  database server host (default: 127.0.0.1)',
                    '  -p, --port=PORT      database server port (default: 5432)',
                    '  -t, --tuples-only    print rows only (pipe-separated)',
                    '  --csv                CSV output mode',
                    '  --json               JSON output mode',
                    '  -V, --version        output version information, then exit'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (this._parsed.version) {
                this.stdOut = `pglite (PostgreSQL 16.4 WASM) ${pkgMeta.version}`;
                return;
            }

            if (this._parsed.daemonAction) {
                await this._handleDaemonAction();
                return;
            }

            try {
                await this._initPg();

                const scripts = [];
                if (this._parsed.file) {
                    const content = this.fs.getFileByPath(this._parsed.file);
                    if (content == null) {
                        this.stdErr = `${binName}: error: ${this._parsed.file}: No such file or directory`;
                        this.exitCode = 1;
                        return;
                    }
                    scripts.push(String(content));
                }
                if (this._parsed.sql !== null) {
                    scripts.push(this._parsed.sql);
                }
                if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) {
                    scripts.push(String(this.stdin));
                }

                for (const sql of scripts) {
                    const out = await this._executeQuery(sql);
                    out.forEach(l => { this.stdOut = l; });
                }
            } catch (err) {
                this.stdErr = `ERROR:  ${err.message || err}`;
                this.exitCode = 1;
            } finally {
                await this.cleanupRepl();
            }
        }
    }

    return PgliteCommand;
}

/**
 * Creates the standard PostgreSQL `pg_ctl` utility command (`pg_ctl start|stop|status|restart -D <dir> -p <port>`).
 */
function createPgCtlCommand(pkgMeta, wbtConfig = {}) {
    class PgCtlCommand extends Command {
        static get name() { return 'pg_ctl'; }
        get name() { return 'pg_ctl'; }
        get requiresFilesystem() { return true; }

        async run() {
            const args = [...(this.arguments || [])];
            if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
                [
                    'pg_ctl is a utility to initialize, start, stop, or control a PGlite PostgreSQL server daemon.',
                    'Usage:',
                    '  pg_ctl start   [-D DATADIR] [-p PORT]',
                    '  pg_ctl stop    [-D DATADIR] [-p PORT]',
                    '  pg_ctl restart [-D DATADIR] [-p PORT]',
                    '  pg_ctl status  [-D DATADIR] [-p PORT]'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            let action = null;
            let dataDir = '/var/lib/postgresql/data';
            let port = 5432;

            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if ((a === '-D' || a === '--pgdata') && i + 1 < args.length) {
                    dataDir = args[++i];
                } else if ((a === '-p' || a === '--port') && i + 1 < args.length) {
                    port = Number(args[++i]) || 5432;
                } else if (a === '-o' && i + 1 < args.length) {
                    // Parse `-o "-p 5433"` style postgres options
                    const optStr = args[++i];
                    const pMatch = optStr.match(/-p\s*(\d+)/);
                    if (pMatch) port = Number(pMatch[1]);
                } else if (!a.startsWith('-') && !action) {
                    action = a.toLowerCase();
                }
            }

            if (action === 'restart') {
                await daemonManager.stopDaemon(port);
                action = 'start';
            }

            const PgliteCmd = createPgliteCommand(pkgMeta, wbtConfig, 'pg_ctl');
            const cmd = new PgliteCmd([action || 'status', '-D', dataDir, '-p', String(port)], this.context);
            cmd.fs = this.fs;
            const res = await cmd.runCommand();
            for (const line of res.getStdOutput()) {
                if (line.type === 'out') this.stdOut = line.string;
                else if (line.type === 'err') this.stdErr = line.string;
            }
            this.exitCode = res.getExitCode();
        }
    }

    return PgCtlCommand;
}

module.exports = createPgliteCommand;
module.exports.createPgliteCommand = createPgliteCommand;
module.exports.createPgCtlCommand = createPgCtlCommand;
module.exports.pgliteInstances = pgliteInstances;

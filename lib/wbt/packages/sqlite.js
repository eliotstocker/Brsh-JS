'use strict';

const ReplCommand = require('../ReplCommand');
const { formatTable, formatPipeList, formatCsv, readBytesFromFs, writeBytesToFs, loadModule } = require('../utils');

let cachedSQLFactory = null;

/**
 * Creates a SQLite3 command class bound to WBT configuration/loader.
 */
function createSqliteCommand(pkgMeta, wbtConfig = {}) {
    class SqliteCommand extends ReplCommand {
        static get name() { return pkgMeta.bin || 'sqlite3'; }
        get name() { return pkgMeta.bin || 'sqlite3'; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
            this._db = null;
            this._mode = this._parsed.mode || 'list';
            this._showHeaders = this._parsed.header;
        }

        _parseArgs(args) {
            let dbPath = null;
            let sql = null;
            let file = null;
            let mode = null;
            let header = false;
            let help = false;
            let version = false;

            const positional = [];
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--help' || arg === '-help' || arg === '-h') {
                    help = true;
                } else if (arg === '--version' || arg === '-version' || arg === '-v') {
                    version = true;
                } else if (arg === '-header' || arg === '--header') {
                    header = true;
                } else if (arg === '-noheader' || arg === '--noheader') {
                    header = false;
                } else if (arg === '-table' || arg === '--table' || arg === '-box' || arg === '--box' || arg === '-column' || arg === '--column') {
                    mode = 'table';
                    header = true;
                } else if (arg === '-csv' || arg === '--csv') {
                    mode = 'csv';
                    header = true;
                } else if (arg === '-json' || arg === '--json') {
                    mode = 'json';
                } else if (arg === '-list' || arg === '--list') {
                    mode = 'list';
                } else if (arg === '-cmd' && i + 1 < args.length) {
                    sql = args[++i];
                } else if (arg === '-init' && i + 1 < args.length) {
                    file = args[++i];
                } else if (!arg.startsWith('-')) {
                    positional.push(arg);
                }
            }

            if (positional.length === 1) {
                // In sqlite3, `sqlite3 db.sqlite` opens db interactively, OR if it looks like a SQL query and no db was given, allow `sqlite3 "SELECT 1"` convenience
                if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|PRAGMA|WITH|BEGIN|EXPLAIN)\b/i.test(positional[0])) {
                    dbPath = ':memory:';
                    sql = positional[0];
                } else {
                    dbPath = positional[0];
                }
            } else if (positional.length >= 2) {
                dbPath = positional[0];
                sql = positional.slice(1).join(' ');
            }

            return {
                dbPath: dbPath || ':memory:',
                sql,
                file,
                mode,
                header,
                help,
                version
            };
        }

        shouldBeInteractive() {
            if (this._parsed.help || this._parsed.version) return false;
            if (this._parsed.sql !== null || this._parsed.file !== null) return false;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) return false;
            return true;
        }

        getReplTitle() {
            return `SQLite3 WASM (${pkgMeta.version}) — ${this._parsed.dbPath}`;
        }

        getReplPrompt() {
            return 'sqlite> ';
        }

        getReplWelcome() {
            return [
                `SQLite version 3.46.0 (sql.js ${pkgMeta.version} WASM)`,
                `Connected to "${this._parsed.dbPath}"`,
                `Enter ".help" for usage hints, ".tables" to list tables, ".exit" to quit.`
            ];
        }

        async _initDatabase() {
            if (!cachedSQLFactory || wbtConfig.moduleLoader) {
                const mod = await loadModule('sql.js', pkgMeta.cdnUrl, wbtConfig.moduleLoader);
                const initSqlJs = mod.default || mod;
                if (typeof initSqlJs === 'function') {
                    cachedSQLFactory = await initSqlJs({
                        locateFile: (file) => pkgMeta.wasmUrl || `https://cdn.jsdelivr.net/npm/sql.js@${pkgMeta.version}/dist/${file}`
                    });
                } else {
                    cachedSQLFactory = initSqlJs;
                }
            }

            const SQL = cachedSQLFactory;
            const dbPath = this._parsed.dbPath;
            if (dbPath && dbPath !== ':memory:') {
                const existingBytes = readBytesFromFs(this.fs, dbPath);
                if (existingBytes && existingBytes.length > 0) {
                    this._db = new SQL.Database(existingBytes);
                    return;
                }
            }
            this._db = new SQL.Database();
        }

        _persistDatabase() {
            if (!this._db) return;
            const dbPath = this._parsed.dbPath;
            if (dbPath && dbPath !== ':memory:') {
                const data = this._db.export();
                writeBytesToFs(this.fs, dbPath, data, 'application/x-sqlite3');
            }
        }

        _executeSqlStatements(sqlText, defaultMode = 'list') {
            const outLines = [];
            const trimmed = sqlText.trim();
            if (!trimmed) return outLines;

            // Dot-commands (.tables, .schema, .mode, .headers, .help)
            if (trimmed.startsWith('.')) {
                const parts = trimmed.split(/\s+/);
                const cmd = parts[0].toLowerCase();
                if (cmd === '.help') {
                    return [
                        '.tables           List names of tables',
                        '.schema [table]   Show the CREATE statements',
                        '.mode MODE        Set output mode (list, table, csv, json)',
                        '.headers on|off   Turn display of headers on or off',
                        '.read FILE        Execute SQL in FILE',
                        '.save FILE        Write in-memory database to FILE',
                        '.exit / .quit     Exit this program'
                    ];
                }
                if (cmd === '.tables') {
                    const res = this._db.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY 1;");
                    if (!res || res.length === 0) return [];
                    const names = res[0].values.map(r => r[0]);
                    return [names.join('  ')];
                }
                if (cmd === '.schema') {
                    const tbl = parts[1];
                    const query = tbl
                        ? `SELECT sql FROM sqlite_master WHERE name = '${tbl.replace(/'/g, "''")}' AND sql IS NOT NULL;`
                        : `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL;`;
                    const res = this._db.exec(query);
                    if (!res || res.length === 0) return [];
                    return res[0].values.map(r => `${r[0]};`);
                }
                if (cmd === '.mode' && parts[1]) {
                    this._mode = parts[1].toLowerCase();
                    return [`mode set to ${this._mode}`];
                }
                if (cmd === '.headers' && parts[1]) {
                    this._showHeaders = parts[1].toLowerCase() === 'on';
                    return [];
                }
                if (cmd === '.save' && parts[1]) {
                    this._parsed.dbPath = parts[1];
                    this._persistDatabase();
                    return [`Saved database to ${parts[1]}`];
                }
                if (cmd === '.read' && parts[1]) {
                    const fileSql = this.fs.getFileByPath(parts[1]);
                    if (fileSql == null) {
                        throw new Error(`Error: cannot open "${parts[1]}"`);
                    }
                    return this._executeSqlStatements(String(fileSql), defaultMode);
                }
                throw new Error(`Error: unknown command or invalid arguments: "${cmd}". Enter ".help" for help`);
            }

            const results = this._db.exec(sqlText);
            this._persistDatabase();

            const activeMode = this._mode || defaultMode;
            for (const result of (results || [])) {
                const { columns, values } = result;
                if (activeMode === 'table' || activeMode === 'box' || activeMode === 'column') {
                    outLines.push(...formatTable(columns, values, { showRowCount: false }));
                } else if (activeMode === 'csv') {
                    outLines.push(...formatCsv(columns, values, this._showHeaders));
                } else if (activeMode === 'json') {
                    const objs = values.map(row => {
                        const obj = {};
                        columns.forEach((c, idx) => { obj[c] = row[idx]; });
                        return obj;
                    });
                    outLines.push(JSON.stringify(objs));
                } else {
                    outLines.push(...formatPipeList(columns, values, this._showHeaders));
                }
            }
            return outLines;
        }

        async initRepl() {
            this._mode = this._parsed.mode || 'table';
            await this._initDatabase();
        }

        async evaluateReplLine(line) {
            try {
                const output = this._executeSqlStatements(line, 'table');
                return { output };
            } catch (err) {
                return { error: `Error: ${err.message || err}` };
            }
        }

        async cleanupRepl() {
            try {
                this._persistDatabase();
                if (this._db && typeof this._db.close === 'function') {
                    this._db.close();
                }
            } catch {
                // ignore
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    'Usage: sqlite3 [OPTIONS] [FILENAME [SQL]]',
                    'Options:',
                    '  -table               set output mode to ASCII table',
                    '  -csv                 set output mode to CSV',
                    '  -json                set output mode to JSON',
                    '  -list                set output mode to pipe-separated list (default)',
                    '  -header              turn headers on',
                    '  -cmd SQL             run SQL command',
                    '  -init FILE           read/process SQL file',
                    '  -version             show SQLite version'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (this._parsed.version) {
                this.stdOut = `3.46.0 (sql.js ${pkgMeta.version} WASM)`;
                return;
            }

            try {
                await this._initDatabase();

                const scriptsToRun = [];
                if (this._parsed.file) {
                    const content = this.fs.getFileByPath(this._parsed.file);
                    if (content == null) {
                        this.stdErr = `sqlite3: Error: cannot open "${this._parsed.file}"`;
                        this.exitCode = 1;
                        return;
                    }
                    scriptsToRun.push(String(content));
                }
                if (this._parsed.sql !== null) {
                    scriptsToRun.push(this._parsed.sql);
                }
                if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) {
                    scriptsToRun.push(String(this.stdin));
                }

                for (const block of scriptsToRun) {
                    // If block has multiple dot-commands on separate lines, process line by line when starting with '.'
                    const lines = block.split(/\r?\n/);
                    let sqlBuf = [];
                    const flushSqlBuf = () => {
                        if (sqlBuf.length > 0) {
                            const out = this._executeSqlStatements(sqlBuf.join('\n'), this._parsed.mode || 'list');
                            out.forEach(l => { this.stdOut = l; });
                            sqlBuf = [];
                        }
                    };
                    for (const line of lines) {
                        if (line.trim().startsWith('.')) {
                            flushSqlBuf();
                            const trimmed = line.trim();
                            if (trimmed === '.exit' || trimmed === '.quit') break;
                            const out = this._executeSqlStatements(trimmed, this._parsed.mode || 'list');
                            out.forEach(l => { this.stdOut = l; });
                        } else {
                            sqlBuf.push(line);
                        }
                    }
                    flushSqlBuf();
                }
            } catch (err) {
                this.stdErr = `Error: ${err.message || err}`;
                this.exitCode = 1;
            } finally {
                await this.cleanupRepl();
            }
        }
    }

    return SqliteCommand;
}

module.exports = createSqliteCommand;

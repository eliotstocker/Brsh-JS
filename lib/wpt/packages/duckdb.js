'use strict';

const ReplCommand = require('../ReplCommand');
const { formatTable, formatPipeList, formatCsv, loadModule } = require('../utils');

function createDuckDbCommand(pkgMeta, wptConfig = {}) {
    class DuckDbCommand extends ReplCommand {
        static get name() { return pkgMeta.bin || 'duckdb'; }
        get name() { return pkgMeta.bin || 'duckdb'; }

        constructor(args, context) {
            super(args, context);
            this._parsed = this._parseArgs(args || []);
            this._mode = this._parsed.mode || 'table';
        }

        _parseArgs(args) {
            let dbPath = ':memory:';
            let sql = null;
            let file = null;
            let mode = 'table';
            let help = false;
            let version = false;

            const positional = [];
            for (let i = 0; i < args.length; i++) {
                const a = args[i];
                if (a === '-h' || a === '--help' || a === '-help') {
                    help = true;
                } else if (a === '-v' || a === '--version' || a === '-version') {
                    version = true;
                } else if ((a === '-c' || a === '-s') && i + 1 < args.length) {
                    sql = args[++i];
                } else if (a === '-f' && i + 1 < args.length) {
                    file = args[++i];
                } else if (a === '-csv' || a === '--csv') {
                    mode = 'csv';
                } else if (a === '-json' || a === '--json') {
                    mode = 'json';
                } else if (a === '-list' || a === '--list') {
                    mode = 'list';
                } else if (a === '-table' || a === '--table' || a === '-box') {
                    mode = 'table';
                } else if (!a.startsWith('-')) {
                    positional.push(a);
                }
            }

            if (positional.length === 1) {
                if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|DESCRIBE|SHOW|WITH|PRAGMA|EXPLAIN|FROM)\b/i.test(positional[0])) {
                    sql = positional[0];
                } else {
                    dbPath = positional[0];
                }
            } else if (positional.length >= 2) {
                dbPath = positional[0];
                sql = positional.slice(1).join(' ');
            }

            return { dbPath, sql, file, mode, help, version };
        }

        shouldBeInteractive() {
            if (this._parsed.help || this._parsed.version) return false;
            if (this._parsed.sql !== null || this._parsed.file !== null) return false;
            if (this.stdin !== undefined && this.stdin !== null && String(this.stdin).trim().length > 0) return false;
            return true;
        }

        getReplTitle() {
            return `DuckDB WASM (${pkgMeta.version}) — ${this._parsed.dbPath}`;
        }

        getReplPrompt() {
            return 'D ';
        }

        getReplWelcome() {
            return [
                `v${pkgMeta.version} (DuckDB-WASM Analytical SQL Engine)`,
                `Enter ".help" for usage hints, ".tables" to list tables, ".exit" to quit.`
            ];
        }

        async _initDuckDb() {
            const mod = await loadModule('@duckdb/duckdb-wasm', pkgMeta.cdnUrl, wptConfig.moduleLoader);
            const duckdb = mod.default || mod;

            if (typeof duckdb.createConnection === 'function') {
                this._conn = await duckdb.createConnection(this._parsed.dbPath, this.fs);
                return;
            }

            if (typeof duckdb.getJsivrBundles === 'function') {
                const bundles = duckdb.getJsivrBundles();
                const bundle = await duckdb.selectBundle(bundles);
                const workerUrl = URL.createObjectURL(
                    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
                );
                const worker = new Worker(workerUrl);
                const logger = new duckdb.ConsoleLogger();
                this._db = new duckdb.AsyncDuckDB(logger, worker);
                await this._db.instantiate(bundle.mainModule, bundle.pthreadWorker);
                this._conn = await this._db.connect();
                return;
            }

            throw new Error('Unsupported DuckDB-WASM module interface');
        }

        async _executeQuery(sqlText) {
            const trimmed = sqlText.trim();
            if (!trimmed) return [];

            if (trimmed === '.tables') {
                return this._executeQuery("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main';");
            }
            if (trimmed === '.help') {
                return [
                    '.tables           List names of tables',
                    '.mode MODE        Set output mode (table, csv, json, list)',
                    '.exit / .quit     Exit DuckDB'
                ];
            }
            if (trimmed.startsWith('.mode ')) {
                this._mode = trimmed.split(/\s+/)[1].toLowerCase();
                return [`mode set to ${this._mode}`];
            }

            const result = await this._conn.query(sqlText);
            if (!result) return [];

            let columns = [];
            let rows = [];

            if (Array.isArray(result.columns) && Array.isArray(result.rows)) {
                columns = result.columns;
                rows = result.rows;
            } else if (typeof result.toArray === 'function') {
                const arr = result.toArray().map(r => (typeof r.toJSON === 'function' ? r.toJSON() : r));
                if (result.schema && Array.isArray(result.schema.fields)) {
                    columns = result.schema.fields.map(f => f.name);
                } else if (arr.length > 0) {
                    columns = Object.keys(arr[0]);
                }
                rows = arr;
            }

            if (columns.length === 0) return [];

            if (this._mode === 'csv') {
                return formatCsv(columns, rows, true);
            }
            if (this._mode === 'json') {
                const objs = rows.map(r => {
                    if (!Array.isArray(r)) return r;
                    const o = {};
                    columns.forEach((c, idx) => { o[c] = r[idx]; });
                    return o;
                });
                return [JSON.stringify(objs)];
            }
            if (this._mode === 'list') {
                return formatPipeList(columns, rows, false);
            }
            return formatTable(columns, rows, { showRowCount: true });
        }

        async initRepl() {
            await this._initDuckDb();
        }

        async evaluateReplLine(line) {
            try {
                const output = await this._executeQuery(line);
                return { output };
            } catch (err) {
                return { error: `Error: ${err.message || err}` };
            }
        }

        async cleanupRepl() {
            if (this._conn && typeof this._conn.close === 'function') {
                try { await this._conn.close(); } catch { /* ignore */ }
            }
        }

        async runNonInteractive() {
            if (this._parsed.help) {
                [
                    'Usage: duckdb [OPTIONS] [FILENAME] [SQL]',
                    'Options:',
                    '  -c SQL               run SQL command and exit',
                    '  -f FILE              read and execute SQL from FILE',
                    '  -csv                 set output mode to CSV',
                    '  -json                set output mode to JSON',
                    '  -table               set output mode to ASCII table (default)',
                    '  -version             print DuckDB version'
                ].forEach(l => { this.stdOut = l; });
                return;
            }

            if (this._parsed.version) {
                this.stdOut = `v${pkgMeta.version} (DuckDB-WASM)`;
                return;
            }

            try {
                await this._initDuckDb();

                const scripts = [];
                if (this._parsed.file) {
                    const content = this.fs.getFileByPath(this._parsed.file);
                    if (content == null) {
                        this.stdErr = `duckdb: Error: cannot open "${this._parsed.file}"`;
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
                this.stdErr = `Error: ${err.message || err}`;
                this.exitCode = 1;
            } finally {
                await this.cleanupRepl();
            }
        }
    }

    return DuckDbCommand;
}

module.exports = createDuckDbCommand;

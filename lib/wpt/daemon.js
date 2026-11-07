'use strict';

/**
 * Daemon & Virtual Localhost Server Registry for WPT / brsh.
 *
 * Allows WASM packages (such as `pglite` / `pg_ctl` or custom WASM servers) to:
 * 1. Register background daemon processes on a virtual localhost port (e.g. 5432)
 * 2. Optionally bind a real Node `http.Server` or `net.Server` when running in Node
 * 3. Intercept `fetch('http://localhost:<port>/...')` or `fetch('http://127.0.0.1:<port>/...')`
 *    in the browser or Node so `curl http://localhost:5432/query -d "SELECT 1"` and web app
 *    `fetch()` calls hit the running WASM daemon directly!
 */
class DaemonManager {
    constructor() {
        this._daemons = new Map(); // id/port -> daemon entry
        this._nextPid = 1001;
        this._fetchPatched = false;
        this._originalFetch = null;
    }

    /**
     * Registers and starts a background daemon.
     *
     * @param {Object} opts
     * @param {string} opts.name - Daemon name (e.g. 'pglite')
     * @param {number} opts.port - Port number (e.g. 5432)
     * @param {string} [opts.host='127.0.0.1'] - Bind address
     * @param {string} [opts.dataDir] - Associated data directory or target
     * @param {Function} opts.handler - async ({ method, url, path, headers, body }) => { status, statusText, headers, body }
     * @param {Function} [opts.onStop] - async cleanup callback when daemon is stopped
     * @param {Object} [opts.instance] - Underlying WASM instance (e.g. PGlite db)
     * @param {Object} [opts.fs] - Optional brsh filesystem to write PID file
     * @param {string} [opts.pidFile] - Optional path to PID file (e.g. `/var/run/pglite.pid`)
     */
    async startDaemon(opts) {
        const {
            name,
            port = 5432,
            host = '127.0.0.1',
            dataDir = 'memory://',
            handler,
            onStop,
            instance,
            fs,
            pidFile
        } = opts;

        const numericPort = Number(port);
        if (this._daemons.has(numericPort)) {
            throw new Error(`Port ${numericPort} is already in use by daemon '${this._daemons.get(numericPort).name}' (PID ${this._daemons.get(numericPort).pid})`);
        }

        const pid = this._nextPid++;
        let nodeHttpServer = null;

        // Ensure global fetch intercepts http://localhost:<port> and http://127.0.0.1:<port>
        this._ensureFetchInterceptor();

        // Also optionally bind a real Node http server if requested and in Node
        if (opts.bindNodeServer && typeof process !== 'undefined' && process.versions && process.versions.node) {
            try {
                const http = require('http');
                nodeHttpServer = http.createServer(async (req, res) => {
                    try {
                        const chunks = [];
                        for await (const chunk of req) chunks.push(chunk);
                        const rawBody = Buffer.concat(chunks).toString('utf8');
                        const urlObj = new URL(req.url || '/', `http://${host}:${numericPort}`);
                        const resp = await handler({
                            method: req.method || 'GET',
                            url: urlObj.toString(),
                            path: urlObj.pathname,
                            searchParams: urlObj.searchParams,
                            headers: req.headers || {},
                            body: rawBody
                        });
                        const status = (resp && resp.status) || 200;
                        const respHeaders = Object.assign({
                            'content-type': 'application/json',
                            'access-control-allow-origin': '*'
                        }, (resp && resp.headers) || {});
                        res.writeHead(status, respHeaders);
                        res.end(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body ?? {}));
                    } catch (err) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message || String(err) }));
                    }
                });
                await new Promise((resolve) => {
                    nodeHttpServer.once('error', () => {
                        nodeHttpServer = null;
                        resolve();
                    });
                    nodeHttpServer.listen(numericPort, host, () => resolve());
                });
            } catch {
                nodeHttpServer = null;
            }
        }

        const entry = {
            pid,
            name,
            port: numericPort,
            host,
            dataDir,
            startedAt: new Date().toISOString(),
            handler,
            onStop,
            instance,
            nodeHttpServer,
            pidFile,
            fs
        };

        this._daemons.set(numericPort, entry);

        if (fs && pidFile) {
            try {
                fs.setFileByPath(pidFile, JSON.stringify({
                    pid,
                    name,
                    port: numericPort,
                    host,
                    dataDir,
                    startedAt: entry.startedAt
                }, null, 2), true);
            } catch { /* ignore */ }
        }

        return entry;
    }

    async stopDaemon(portOrNameOrPid) {
        const entry = this.getDaemon(portOrNameOrPid);
        if (!entry) return null;

        this._daemons.delete(entry.port);

        if (entry.nodeHttpServer) {
            await new Promise(resolve => entry.nodeHttpServer.close(() => resolve()));
        }

        if (typeof entry.onStop === 'function') {
            try { await entry.onStop(entry); } catch { /* ignore */ }
        }

        if (entry.fs && entry.pidFile) {
            try { entry.fs.deleteFileByPath(entry.pidFile); } catch { /* ignore */ }
        }

        return entry;
    }

    async stopAll() {
        const ports = Array.from(this._daemons.keys());
        for (const p of ports) {
            await this.stopDaemon(p);
        }
    }

    getDaemon(portOrNameOrPid) {
        if (portOrNameOrPid === undefined || portOrNameOrPid === null) {
            // Return first daemon if only one is running
            if (this._daemons.size === 1) {
                return this._daemons.values().next().value;
            }
            return null;
        }
        const num = Number(portOrNameOrPid);
        if (!Number.isNaN(num) && this._daemons.has(num)) {
            return this._daemons.get(num);
        }
        for (const entry of this._daemons.values()) {
            if (entry.pid === num || entry.name === String(portOrNameOrPid).toLowerCase() || entry.dataDir === portOrNameOrPid) {
                return entry;
            }
        }
        return null;
    }

    listDaemons() {
        return Array.from(this._daemons.values());
    }

    _ensureFetchInterceptor() {
        if (this._fetchPatched || typeof globalThis.fetch !== 'function') return;
        const originalFetch = globalThis.fetch.bind(globalThis);
        this._originalFetch = originalFetch;
        const self = this;

        const patchedFetch = async function wptDaemonFetch(input, init = {}) {
            const urlStr = typeof input === 'string'
                ? input
                : (input && typeof input.url === 'string' ? input.url : String(input));

            const match = urlStr.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)(\/.*)?$/i);
            if (match) {
                const port = Number(match[1]);
                const daemon = self._daemons.get(port);
                if (daemon && typeof daemon.handler === 'function') {
                    const urlObj = new URL(urlStr);
                    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
                    const headers = {};
                    if (init.headers) {
                        if (typeof init.headers.forEach === 'function') {
                            init.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
                        } else if (typeof init.headers === 'object') {
                            for (const [k, v] of Object.entries(init.headers)) {
                                headers[k.toLowerCase()] = v;
                            }
                        }
                    }
                    const body = init.body !== undefined && init.body !== null ? String(init.body) : null;

                    const resp = await daemon.handler({
                        method,
                        url: urlStr,
                        path: urlObj.pathname,
                        searchParams: urlObj.searchParams,
                        headers,
                        body
                    });

                    const status = (resp && resp.status) || 200;
                    const statusText = (resp && resp.statusText) || (status === 200 ? 'OK' : 'Error');
                    const respBody = typeof resp?.body === 'string'
                        ? resp.body
                        : JSON.stringify(resp?.body ?? {});
                    const respHeaders = new Map(Object.entries(Object.assign({
                        'content-type': 'application/json',
                        'x-powered-by': `${daemon.name}-wasm-daemon`
                    }, (resp && resp.headers) || {})));

                    return {
                        ok: status >= 200 && status < 300,
                        status,
                        statusText,
                        headers: {
                            get: (k) => respHeaders.get(String(k).toLowerCase()) || null,
                            forEach: (cb) => respHeaders.forEach((v, k) => cb(v, k))
                        },
                        text: async () => respBody,
                        json: async () => JSON.parse(respBody),
                        arrayBuffer: async () => new TextEncoder().encode(respBody).buffer
                    };
                }
            }

            return originalFetch(input, init);
        };

        patchedFetch.__isWptDaemonFetch = true;
        globalThis.fetch = patchedFetch;
        this._fetchPatched = true;
    }
}

const daemonManager = new DaemonManager();

module.exports = {
    DaemonManager,
    daemonManager
};

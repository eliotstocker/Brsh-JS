'use strict';

const LocalCommand = require('./LocalCommand');

class Curl extends LocalCommand {
    static get name() { return 'curl'; }
    get requiresFilesystem() { return true; }

    run() {
        const args = [...this.arguments];
        let method = null;
        const headers = {};
        let body = null;
        let includeHeaders = false;
        let silent = false;
        let outputFile = null;
        let url = null;

        let i = 0;
        while (i < args.length) {
            const arg = args[i];
            switch (arg) {
                case '-X': case '--request':
                    method = args[++i];
                    break;
                case '-H': case '--header': {
                    const raw = args[++i] || '';
                    const colon = raw.indexOf(':');
                    if (colon > 0) {
                        headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
                    }
                    break;
                }
                case '-d': case '--data': case '--data-raw':
                    body = args[++i];
                    if (!method) method = 'POST';
                    break;
                case '-u': case '--user': {
                    const creds = args[++i] || '';
                    headers['Authorization'] = 'Basic ' + btoa(creds);
                    break;
                }
                case '-o': case '--output':
                    outputFile = args[++i];
                    break;
                case '-i': case '--include':
                    includeHeaders = true;
                    break;
                case '-s': case '--silent':
                    silent = true;
                    break;
                case '-L': case '--location':
                    // fetch follows redirects by default — accepted and ignored
                    break;
                default:
                    if (!arg.startsWith('-')) {
                        url = arg;
                    } else if (!silent) {
                        this.stdErr = `curl: unknown option '${arg}'`;
                    }
            }
            i++;
        }

        if (!url) {
            this.stdErr = 'curl: no URL specified';
            this.exitCode = 1;
            return Promise.resolve();
        }

        // Validate URL scheme to prevent file:// or data: abuse
        if (!/^https?:\/\//i.test(url)) {
            this.stdErr = `curl: unsupported protocol in URL: ${url}`;
            this.exitCode = 1;
            return Promise.resolve();
        }

        const fetchOptions = {
            method: method || 'GET',
            headers,
        };
        if (body !== null) fetchOptions.body = body;

        return fetch(url, fetchOptions)
            .then(async (res) => {
                if (includeHeaders) {
                    this.stdOut = `HTTP/1.1 ${res.status} ${res.statusText}`;
                    res.headers.forEach((value, name) => {
                        this.stdOut = `${name}: ${value}`;
                    });
                    this.stdOut = '';
                }

                const text = await res.text();

                if (outputFile) {
                    try {
                        this.fs.setFileByPath(outputFile, text, false);
                    } catch(e) {
                        this.stdErr = `curl: cannot write to '${outputFile}': ${e.message}`;
                        this.exitCode = 1;
                    }
                } else {
                    text.split(/\r?\n/).forEach(line => { this.stdOut = line; });
                }

                if (!res.ok) {
                    this.exitCode = 22;
                }
            })
            .catch((err) => {
                if (!silent) {
                    const msg = (err && err.message) ? err.message : String(err);
                    // Browsers surface CORS and mixed-content failures as opaque TypeErrors
                    // with no status — the actual reason is intentionally hidden by the browser.
                    const likelyNetworkBlock =
                        err instanceof TypeError &&
                        /failed to fetch|networkerror|load failed|fetch is aborted/i.test(msg);

                    if (likelyNetworkBlock) {
                        const isHttps = /^https:\/\//i.test(url);
                        const pageSsl = typeof location !== 'undefined' && location.protocol === 'https:';
                        if (!isHttps && pageSsl) {
                            this.stdErr = `curl: (35) Mixed content blocked — the page is served over HTTPS but the target URL is HTTP. Browsers block insecure requests from secure pages.`;
                        } else {
                            this.stdErr = `curl: (6) Network request failed — this is likely a CORS error. The server at ${url} did not include the required 'Access-Control-Allow-Origin' response header. You can only fetch cross-origin resources that explicitly allow it.`;
                            this.stdErr = `       Hint: try a public CORS proxy, or ensure the server sends 'Access-Control-Allow-Origin: *'.`;
                        }
                    } else {
                        this.stdErr = `curl: (6) Could not connect: ${msg}`;
                    }
                }
                this.exitCode = 6;
            });
    }
}

module.exports = Curl;

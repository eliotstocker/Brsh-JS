'use strict';

/**
 * Formats query result rows into a clean ASCII table (similar to psql / sqlite3 -table).
 *
 * @param {string[]} columns
 * @param {Array<Object|Array>} rows
 * @param {Object} [options]
 * @param {boolean} [options.showRowCount=true]
 * @returns {string[]} Array of lines
 */
function formatTable(columns, rows, options = {}) {
    const { showRowCount = true } = options;

    if (!columns || columns.length === 0) {
        return [];
    }

    const colNames = columns.map(c => String(c));
    const widths = colNames.map(c => c.length);

    const normalizedRows = (rows || []).map(row => {
        return colNames.map((col, idx) => {
            const val = Array.isArray(row) ? row[idx] : row[col];
            const str = val === null || val === undefined ? 'NULL' : String(val);
            if (str.length > widths[idx]) {
                widths[idx] = str.length;
            }
            return str;
        });
    });

    const lines = [];
    const header = colNames.map((col, i) => ' ' + col.padEnd(widths[i]) + ' ').join('|');
    const separator = widths.map(w => '-'.repeat(w + 2)).join('+');

    lines.push(header);
    lines.push(separator);

    for (const r of normalizedRows) {
        lines.push(r.map((cell, i) => ' ' + cell.padEnd(widths[i]) + ' ').join('|'));
    }

    if (showRowCount) {
        lines.push(`(${normalizedRows.length} row${normalizedRows.length === 1 ? '' : 's'})`);
    }

    return lines;
}

/**
 * Formats rows in pipe-separated list mode (default sqlite3 style).
 */
function formatPipeList(columns, rows, showHeader = false) {
    const lines = [];
    const colNames = (columns || []).map(c => String(c));
    if (showHeader && colNames.length > 0) {
        lines.push(colNames.join('|'));
    }
    for (const row of (rows || [])) {
        const vals = colNames.map((col, idx) => {
            const val = Array.isArray(row) ? row[idx] : row[col];
            return val === null || val === undefined ? '' : String(val);
        });
        lines.push(vals.join('|'));
    }
    return lines;
}

/**
 * Formats rows as CSV.
 */
function formatCsv(columns, rows, showHeader = true) {
    const escapeCsv = (val) => {
        const str = val === null || val === undefined ? '' : String(val);
        if (/[",\r\n]/.test(str)) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };

    const lines = [];
    const colNames = (columns || []).map(c => String(c));
    if (showHeader && colNames.length > 0) {
        lines.push(colNames.map(escapeCsv).join(','));
    }
    for (const row of (rows || [])) {
        const vals = colNames.map((col, idx) => {
            const val = Array.isArray(row) ? row[idx] : row[col];
            return escapeCsv(val);
        });
        lines.push(vals.join(','));
    }
    return lines;
}

/**
 * Reads a file from the brsh filesystem as a Uint8Array (works with both BinaryFile,
 * raw Uint8Array/Buffer, data: URIs, or binary strings).
 */
function readBytesFromFs(fs, filepath) {
    if (!fs || !fs.exists(filepath)) return null;
    if (fs.isRealFilesystem) {
        try {
            const nodeFs = require('fs');
            return new Uint8Array(nodeFs.readFileSync(fs.absolutePath(filepath)));
        } catch {
            return null;
        }
    }
    const content = fs.getFileByPath(filepath);
    if (content == null) return null;
    if (content instanceof Uint8Array) {
        return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(content)) {
        return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    if (content instanceof ArrayBuffer) {
        return new Uint8Array(content);
    }
    if (typeof content === 'string') {
        if (content.startsWith('data:')) {
            const comma = content.indexOf(',');
            if (comma !== -1) {
                const b64 = content.slice(comma + 1);
                if (typeof Buffer !== 'undefined') {
                    return new Uint8Array(Buffer.from(b64, 'base64'));
                }
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            }
        }
        const bytes = new Uint8Array(content.length);
        for (let i = 0; i < content.length; i++) {
            bytes[i] = content.charCodeAt(i) & 0xff;
        }
        return bytes;
    }
    return null;
}

/**
 * Writes a Uint8Array to the brsh filesystem (as a BinaryFile on virtual FS, or Buffer on real FS).
 */
function writeBytesToFs(fs, filepath, bytes, mimeType = 'application/octet-stream') {
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (fs.isRealFilesystem) {
        const nodeFs = require('fs');
        const nodePath = require('path');
        const abs = fs.absolutePath(filepath);
        nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
        nodeFs.writeFileSync(abs, Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength));
        return;
    }
    const { BinaryFile } = require('../FileSystem');
    const copy = new Uint8Array(uint8.byteLength);
    copy.set(uint8);
    const bf = new BinaryFile(copy.buffer, mimeType);
    fs.setFileByPath(filepath, bf, true);
}

/**
 * Dynamically imports a package by trying local module resolution first, then CDN URL.
 * Supports dependency injection via `customLoader` for offline testing.
 */
async function loadModule(pkgName, cdnUrl, customLoader = null) {
    if (typeof customLoader === 'function') {
        const res = await customLoader(pkgName, cdnUrl);
        if (res) return res;
    }

    // 1. Try local npm package first (in Node or bundled environments)
    try {
        const mod = await import(/* @vite-ignore */ pkgName);
        if (mod) return mod;
    } catch {
        // Fallback to CDN
    }

    // 2. Try CDN URL (works natively in browsers and in Node with HTTPS import or fetch)
    if (cdnUrl) {
        try {
            return await import(/* @vite-ignore */ cdnUrl);
        } catch (err) {
            throw new Error(`Failed to load WASM package '${pkgName}' from ${cdnUrl}: ${err.message || err}`);
        }
    }

    throw new Error(`Package '${pkgName}' could not be loaded`);
}

/**
 * Formats a standardized `--help` screen for any WASM binary managed by `wbt` or `WasmCommand`.
 *
 * @param {string} binName
 * @param {Object} [pkgMeta]
 * @returns {string[]} Array of lines
 */
function formatWasmHelp(binName, pkgMeta = {}) {
    const pkgName = pkgMeta.name || binName;
    const version = pkgMeta.version || 'wasm';
    const desc = pkgMeta.description || 'WebAssembly binary';
    const replCfg = (pkgMeta && typeof pkgMeta.repl === 'object') ? pkgMeta.repl : (pkgMeta.repl ? {} : null);

    const defaultUsage = replCfg
        ? `${binName} [options] ${replCfg.evalFlag ? `[${replCfg.evalFlag} <code>] ` : ''}[file] [args...]`
        : `${binName} [options] [args...]`;

    const lines = [
        `${binName} (${pkgName} ${version} wasm) — ${desc}`,
        `Usage: ${pkgMeta.usage || defaultUsage}`
    ];

    if (pkgMeta.details) {
        lines.push('', pkgMeta.details);
    }

    lines.push('', 'Options:');
    if (Array.isArray(pkgMeta.options) && pkgMeta.options.length > 0) {
        for (const opt of pkgMeta.options) {
            lines.push(`  ${opt}`);
        }
    } else if (replCfg) {
        if (replCfg.evalFlag) {
            lines.push(`  ${replCfg.evalFlag.padEnd(20)}Evaluate inline code and print result`);
        }
        lines.push(`  (no arguments)      Start interactive ${binName} REPL shell`);
    }
    lines.push('  -h, --help          Show this help message and exit');
    lines.push('  -V, --version       Show WebAssembly binary version and exit');

    if (Array.isArray(pkgMeta.aliases) && pkgMeta.aliases.length > 0) {
        lines.push('', `Aliases: ${pkgMeta.aliases.join(', ')}`);
    }
    if (pkgMeta.homepage || pkgMeta.cdnUrl || pkgMeta.wasmUrl) {
        lines.push(`Source:  ${pkgMeta.homepage || pkgMeta.cdnUrl || pkgMeta.wasmUrl}`);
    }

    return lines;
}

module.exports = {
    formatTable,
    formatPipeList,
    formatCsv,
    readBytesFromFs,
    writeBytesToFs,
    loadModule,
    formatWasmHelp
};

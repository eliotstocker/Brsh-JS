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

const {
    readBytesFromFs,
    writeBytesToFs,
    loadModule,
    extractHelpFromText,
    inspectWasmBytes,
    formatWasmHelp
} = require('../WasmCommand');

module.exports = {
    formatTable,
    formatPipeList,
    formatCsv,
    readBytesFromFs,
    writeBytesToFs,
    loadModule,
    extractHelpFromText,
    inspectWasmBytes,
    formatWasmHelp
};



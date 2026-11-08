'use strict';

import {
    ATTR_BOLD,
    ATTR_DIM,
    ATTR_ITALIC,
    ATTR_UNDERLINE,
    ATTR_BLINK,
    ATTR_INVERSE,
    ATTR_HIDDEN,
    ATTR_STRIKE
} from './ScreenBuffer.js';
import { sanitizeUrl, DEFAULT_URL_WHITELIST } from './VtParser.js';

const ANSI_COLOR_NAMES = [
    'ansi-black',
    'ansi-red',
    'ansi-green',
    'ansi-yellow',
    'ansi-blue',
    'ansi-magenta',
    'ansi-cyan',
    'ansi-white',
    'ansi-bright-black',
    'ansi-bright-red',
    'ansi-bright-green',
    'ansi-bright-yellow',
    'ansi-bright-blue',
    'ansi-bright-magenta',
    'ansi-bright-cyan',
    'ansi-bright-white'
];

const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function colorIndexToCss(idx) {
    if (typeof idx === 'string') return idx;
    if (typeof idx !== 'number' || idx < 16 || idx > 255) return null;
    if (idx >= 232) {
        const v = 8 + (idx - 232) * 10;
        return `rgb(${v}, ${v}, ${v})`;
    }
    const n = idx - 16;
    const r = CUBE_STEPS[Math.floor(n / 36) % 6];
    const g = CUBE_STEPS[Math.floor(n / 6) % 6];
    const b = CUBE_STEPS[n % 6];
    return `rgb(${r}, ${g}, ${b})`;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const AUTO_URL_REGEX = /(?:https?:\/\/|mailto:|tel:)[^\s<>"'`]+/g;

function trimUrlTrailingPunct(url) {
    let end = url.length;
    while (end > 0) {
        const ch = url[end - 1];
        if ('.!?,;:'.includes(ch)) {
            end--;
        } else if (ch === ')') {
            const slice = url.slice(0, end);
            const opens = (slice.match(/\(/g) || []).length;
            const closes = (slice.match(/\)/g) || []).length;
            if (closes > opens) end--;
            else break;
        } else if (ch === ']') {
            const slice = url.slice(0, end);
            const opens = (slice.match(/\[/g) || []).length;
            const closes = (slice.match(/\]/g) || []).length;
            if (closes > opens) end--;
            else break;
        } else {
            break;
        }
    }
    return url.slice(0, end);
}

function detectRowLinks(rowCells, whitelist = DEFAULT_URL_WHITELIST) {
    let lineStr = '';
    for (let c = 0; c < rowCells.length; c++) {
        lineStr += rowCells[c].ch || ' ';
    }

    const links = new Array(rowCells.length).fill(null);
    for (let c = 0; c < rowCells.length; c++) {
        if (rowCells[c].link) {
            links[c] = rowCells[c].link;
        }
    }

    AUTO_URL_REGEX.lastIndex = 0;
    let match;
    while ((match = AUTO_URL_REGEX.exec(lineStr)) !== null) {
        const cleaned = trimUrlTrailingPunct(match[0]);
        const valid = sanitizeUrl(cleaned, whitelist);
        if (!valid) continue;
        const start = match.index;
        const end = start + cleaned.length;
        for (let c = start; c < end && c < links.length; c++) {
            if (!links[c]) {
                links[c] = valid;
            }
        }
    }
    return links;
}

class DomRenderer {
    constructor(container, screen, options = {}) {
        this.container = container;
        this.screen = screen;
        this.cursorStyle = options.cursor || 'none';
        this.urlWhitelist = options.urlWhitelist || DEFAULT_URL_WHITELIST;
        this._rowElements = [];
        this._rafId = null;
        this._lastCursorRow = -1;
        this._lastCursorCol = -1;
        this._lastCursorVisible = false;
    }

    scheduleRender() {
        if (this._rafId !== null) return;
        if (typeof requestAnimationFrame === 'function') {
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this.flushRender();
            });
        } else {
            this.flushRender();
        }
    }

    flushRender() {
        if (this._rafId !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (!this.container || typeof document === 'undefined') return;

        const rows = this.screen.rows;
        this._ensureRowElements(rows);

        const showCursor = this.cursorStyle !== 'none'
            && this.screen.cursorVisible
            && this.screen.viewportOffset === 0;
        const curRow = showCursor ? this.screen.cursorRow : -1;
        const curCol = showCursor ? this.screen.cursorCol : -1;

        if (this._lastCursorRow !== curRow || this._lastCursorCol !== curCol || this._lastCursorVisible !== showCursor) {
            if (this._lastCursorRow >= 0 && this._lastCursorRow < rows) {
                this.screen.dirtyRows.add(this._lastCursorRow);
            }
            if (curRow >= 0 && curRow < rows) {
                this.screen.dirtyRows.add(curRow);
            }
            this._lastCursorRow = curRow;
            this._lastCursorCol = curCol;
            this._lastCursorVisible = showCursor;
        }

        for (const r of this.screen.dirtyRows) {
            if (r >= 0 && r < rows) {
                this._renderRow(r, r === curRow ? curCol : -1);
            }
        }
        this.screen.dirtyRows.clear();
        this.screen.fullRedrawNeeded = false;
    }

    _ensureRowElements(count) {
        while (this._rowElements.length < count) {
            const el = document.createElement('li');
            if (el.classList) {
                el.classList.add('terminal__line');
                el.classList.add('terminal__row');
            }
            this.container.appendChild(el);
            this._rowElements.push(el);
        }
        while (this._rowElements.length > count) {
            const removed = this._rowElements.pop();
            if (removed && removed.parentNode === this.container && this.container.removeChild) {
                this.container.removeChild(removed);
            }
        }
    }

    _renderRow(rowIndex, cursorCol) {
        const rowEl = this._rowElements[rowIndex];
        const cells = this.screen.getVisibleRow(rowIndex);
        if (!rowEl || !cells) return;

        const links = detectRowLinks(cells, this.urlWhitelist);

        // Determine rightmost meaningful cell so we don't emit trailing unstyled spaces
        // unless in alt screen or up to the cursor column.
        let lastCol = this.screen.isAltScreen ? cells.length - 1 : -1;
        if (!this.screen.isAltScreen) {
            for (let c = cells.length - 1; c >= 0; c--) {
                const cell = cells[c];
                if (cell.ch !== ' ' || cell.fg !== null || cell.bg !== null || cell.flags !== 0 || links[c] !== null) {
                    lastCol = c;
                    break;
                }
            }
            if (cursorCol > lastCol) {
                lastCol = cursorCol;
            }
        }

        if (lastCol < 0) {
            rowEl.innerHTML = '';
            return;
        }

        let html = '';
        let runText = '';
        let runKey = null;
        let runCell = null;
        let runLink = null;
        let runIsCursor = false;

        const flushRun = () => {
            if (!runText) return;
            html += this._formatRun(runText, runCell, runLink, runIsCursor);
            runText = '';
        };

        for (let c = 0; c <= lastCol; c++) {
            const cell = cells[c];
            const link = links[c];
            const isCursor = c === cursorCol;
            const key = `${cell.fg ?? ''}|${cell.bg ?? ''}|${cell.flags}|${link ?? ''}|${isCursor ? 1 : 0}`;

            if (key !== runKey) {
                flushRun();
                runKey = key;
                runCell = cell;
                runLink = link;
                runIsCursor = isCursor;
            }
            runText += cell.ch || ' ';
        }
        flushRun();

        rowEl.innerHTML = html;
    }

    _formatRun(text, cell, link, isCursor) {
        const classes = [];
        const styles = [];
        const flags = cell.flags || 0;
        const inverse = (flags & ATTR_INVERSE) !== 0;

        const fg = inverse ? cell.bg : cell.fg;
        const bg = inverse ? cell.fg : cell.bg;

        if (inverse && cell.fg === null && cell.bg === null) {
            classes.push('terminal__inverse');
        }

        if (typeof fg === 'number' && fg >= 0 && fg < 16) {
            classes.push(`${ANSI_COLOR_NAMES[fg]}-fg`);
        } else if (fg !== null) {
            const css = colorIndexToCss(fg);
            if (css) styles.push(`color:${css}`);
        }

        if (typeof bg === 'number' && bg >= 0 && bg < 16) {
            classes.push(`${ANSI_COLOR_NAMES[bg]}-bg`);
        } else if (bg !== null) {
            const css = colorIndexToCss(bg);
            if (css) styles.push(`background-color:${css}`);
        }

        if (flags & ATTR_BOLD) styles.push('font-weight:bold');
        if (flags & ATTR_DIM) styles.push('opacity:0.65');
        if (flags & ATTR_ITALIC) styles.push('font-style:italic');
        if ((flags & ATTR_UNDERLINE) && (flags & ATTR_STRIKE)) {
            styles.push('text-decoration:underline line-through');
        } else if (flags & ATTR_UNDERLINE) {
            styles.push('text-decoration:underline');
        } else if (flags & ATTR_STRIKE) {
            styles.push('text-decoration:line-through');
        }
        if (flags & ATTR_BLINK) classes.push('terminal__blink');
        if (flags & ATTR_HIDDEN) styles.push('visibility:hidden');

        if (isCursor) {
            classes.push('terminal__cursor');
            classes.push(this.cursorStyle);
        }

        const escapedText = escapeHtml(text);
        let inner = escapedText;

        if (classes.length > 0 || styles.length > 0) {
            const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : '';
            const styleAttr = styles.length > 0 ? ` style="${styles.join(';')}"` : '';
            inner = `<span${classAttr}${styleAttr}>${escapedText}</span>`;
        }

        if (link) {
            const safeHref = escapeHtml(link);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="terminal__link">${inner}</a>`;
        }

        return inner;
    }
}

export {
    DomRenderer,
    detectRowLinks,
    trimUrlTrailingPunct,
    colorIndexToCss
};
export default DomRenderer;

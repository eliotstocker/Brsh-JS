'use strict';

const ATTR_BOLD = 1;
const ATTR_DIM = 2;
const ATTR_ITALIC = 4;
const ATTR_UNDERLINE = 8;
const ATTR_BLINK = 16;
const ATTR_INVERSE = 32;
const ATTR_HIDDEN = 64;
const ATTR_STRIKE = 128;

function createCell(ch = ' ', fg = null, bg = null, flags = 0, link = null) {
    return { ch, fg, bg, flags, link };
}

function cloneCell(cell) {
    return {
        ch: cell.ch,
        fg: cell.fg,
        bg: cell.bg,
        flags: cell.flags,
        link: cell.link
    };
}

class ScreenBuffer {
    constructor(cols = 80, rows = 24, options = {}) {
        this.cols = Math.max(1, cols);
        this.rows = Math.max(1, rows);
        this.maxScrollback = options.maxScrollback ?? 1000;
        this.convertEol = options.convertEol !== false;

        this.scrollback = [];
        this.viewportOffset = 0; // 0 = at bottom; >0 = lines scrolled up into scrollback

        this.primaryGrid = this._createGrid(this.cols, this.rows);
        this.altGrid = this._createGrid(this.cols, this.rows);
        this.isAltScreen = false;

        this.cursorRow = 0;
        this.cursorCol = 0;
        this.pendingWrap = false;
        this.cursorVisible = true;
        this.autoWrap = true;
        this.originMode = false;

        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;

        // Current graphic attributes applied to newly written characters
        this.curFg = null;
        this.curBg = null;
        this.curFlags = 0;
        this.curLink = null;

        this._savedPrimary = null;
        this._savedCursorPrimary = null;
        this._savedCursorAlt = null;

        this.dirtyRows = new Set();
        this.fullRedrawNeeded = true;
        this._markAllDirty();
    }

    get grid() {
        return this.isAltScreen ? this.altGrid : this.primaryGrid;
    }

    _createRow(cols = this.cols, fillAttr = false) {
        const fg = fillAttr ? this.curFg : null;
        const bg = fillAttr ? this.curBg : null;
        const flags = fillAttr ? this.curFlags : 0;
        const row = new Array(cols);
        for (let c = 0; c < cols; c++) {
            row[c] = createCell(' ', fg, bg, flags, null);
        }
        return row;
    }

    _createGrid(cols, rows) {
        const grid = new Array(rows);
        for (let r = 0; r < rows; r++) {
            grid[r] = this._createRow(cols, false);
        }
        return grid;
    }

    _markRowDirty(r) {
        if (r >= 0 && r < this.rows) {
            this.dirtyRows.add(r);
        }
    }

    _markRangeDirty(startRow, endRow) {
        const lo = Math.max(0, startRow);
        const hi = Math.min(this.rows - 1, endRow);
        for (let r = lo; r <= hi; r++) {
            this.dirtyRows.add(r);
        }
    }

    _markAllDirty() {
        this.fullRedrawNeeded = true;
        for (let r = 0; r < this.rows; r++) {
            this.dirtyRows.add(r);
        }
    }

    reset() {
        this.scrollback = [];
        this.viewportOffset = 0;
        this.primaryGrid = this._createGrid(this.cols, this.rows);
        this.altGrid = this._createGrid(this.cols, this.rows);
        this.isAltScreen = false;
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.pendingWrap = false;
        this.cursorVisible = true;
        this.autoWrap = true;
        this.originMode = false;
        this.scrollTop = 0;
        this.scrollBottom = this.rows - 1;
        this.curFg = null;
        this.curBg = null;
        this.curFlags = 0;
        this.curLink = null;
        this._savedPrimary = null;
        this._savedCursorPrimary = null;
        this._savedCursorAlt = null;
        this._markAllDirty();
    }

    resetAttributes() {
        this.curFg = null;
        this.curBg = null;
        this.curFlags = 0;
    }

    saveCursor() {
        const state = {
            row: this.cursorRow,
            col: this.cursorCol,
            pendingWrap: this.pendingWrap,
            fg: this.curFg,
            bg: this.curBg,
            flags: this.curFlags,
            originMode: this.originMode,
            autoWrap: this.autoWrap
        };
        if (this.isAltScreen) {
            this._savedCursorAlt = state;
        } else {
            this._savedCursorPrimary = state;
        }
    }

    restoreCursor() {
        const state = this.isAltScreen ? this._savedCursorAlt : this._savedCursorPrimary;
        if (!state) return;
        this._markRowDirty(this.cursorRow);
        this.cursorRow = Math.min(this.rows - 1, Math.max(0, state.row));
        this.cursorCol = Math.min(this.cols - 1, Math.max(0, state.col));
        this.pendingWrap = Boolean(state.pendingWrap);
        this.curFg = state.fg;
        this.curBg = state.bg;
        this.curFlags = state.flags;
        this.originMode = state.originMode;
        this.autoWrap = state.autoWrap;
        this._markRowDirty(this.cursorRow);
    }

    enterAltScreen(clear = true) {
        if (!this.isAltScreen) {
            this._savedPrimary = {
                cursorRow: this.cursorRow,
                cursorCol: this.cursorCol,
                pendingWrap: this.pendingWrap,
                fg: this.curFg,
                bg: this.curBg,
                flags: this.curFlags,
                scrollTop: this.scrollTop,
                scrollBottom: this.scrollBottom,
                originMode: this.originMode,
                autoWrap: this.autoWrap
            };
            this.isAltScreen = true;
            this.viewportOffset = 0;
            this.scrollTop = 0;
            this.scrollBottom = this.rows - 1;
        }
        if (clear) {
            this.altGrid = this._createGrid(this.cols, this.rows);
            this.cursorRow = 0;
            this.cursorCol = 0;
            this.pendingWrap = false;
        }
        this._markAllDirty();
    }

    exitAltScreen() {
        if (!this.isAltScreen) return;
        this.isAltScreen = false;
        if (this._savedPrimary) {
            this.cursorRow = Math.min(this.rows - 1, Math.max(0, this._savedPrimary.cursorRow));
            this.cursorCol = Math.min(this.cols - 1, Math.max(0, this._savedPrimary.cursorCol));
            this.pendingWrap = this._savedPrimary.pendingWrap;
            this.curFg = this._savedPrimary.fg;
            this.curBg = this._savedPrimary.bg;
            this.curFlags = this._savedPrimary.flags;
            this.scrollTop = Math.min(this.rows - 1, this._savedPrimary.scrollTop);
            this.scrollBottom = Math.min(this.rows - 1, Math.max(this.scrollTop, this._savedPrimary.scrollBottom));
            this.originMode = this._savedPrimary.originMode;
            this.autoWrap = this._savedPrimary.autoWrap;
            this._savedPrimary = null;
        } else {
            this.scrollTop = 0;
            this.scrollBottom = this.rows - 1;
        }
        this._markAllDirty();
    }

    setScrollRegion(top, bottom) {
        const t = Math.max(1, top || 1) - 1;
        const b = bottom ? Math.min(this.rows, bottom) - 1 : this.rows - 1;
        if (t < b && t >= 0 && b < this.rows) {
            this.scrollTop = t;
            this.scrollBottom = b;
        } else {
            this.scrollTop = 0;
            this.scrollBottom = this.rows - 1;
        }
        this.setCursor(0, 0);
    }

    setCursor(row, col) {
        this._markRowDirty(this.cursorRow);
        const minRow = this.originMode ? this.scrollTop : 0;
        const maxRow = this.originMode ? this.scrollBottom : this.rows - 1;
        const targetRow = (this.originMode ? this.scrollTop : 0) + row;
        this.cursorRow = Math.max(minRow, Math.min(maxRow, targetRow));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, col));
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    moveCursorRelative(dRow, dCol) {
        this._markRowDirty(this.cursorRow);
        if (dRow !== 0) {
            const minRow = this.cursorRow >= this.scrollTop && this.cursorRow <= this.scrollBottom
                ? (dRow < 0 ? this.scrollTop : 0)
                : 0;
            const maxRow = this.cursorRow >= this.scrollTop && this.cursorRow <= this.scrollBottom
                ? (dRow > 0 ? this.scrollBottom : this.rows - 1)
                : this.rows - 1;
            this.cursorRow = Math.max(minRow, Math.min(maxRow, this.cursorRow + dRow));
        }
        if (dCol !== 0) {
            this.cursorCol = Math.max(0, Math.min(this.cols - 1, this.cursorCol + dCol));
        }
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    putChar(ch) {
        if (this.pendingWrap) {
            if (this.autoWrap) {
                this.cursorCol = 0;
                this.pendingWrap = false;
                this._indexDown();
            } else {
                this.pendingWrap = false;
            }
        }

        const row = this.grid[this.cursorRow];
        if (row && this.cursorCol >= 0 && this.cursorCol < this.cols) {
            const cell = row[this.cursorCol];
            cell.ch = ch;
            cell.fg = this.curFg;
            cell.bg = this.curBg;
            cell.flags = this.curFlags;
            cell.link = this.curLink;
            this._markRowDirty(this.cursorRow);
        }

        if (this.cursorCol < this.cols - 1) {
            this.cursorCol++;
        } else {
            this.pendingWrap = true;
        }
    }

    carriageReturn() {
        this._markRowDirty(this.cursorRow);
        this.cursorCol = 0;
        this.pendingWrap = false;
    }

    lineFeed() {
        this._markRowDirty(this.cursorRow);
        if (this.convertEol) {
            this.cursorCol = 0;
        }
        this.pendingWrap = false;
        this._indexDown();
        this._markRowDirty(this.cursorRow);
    }

    index() {
        this._markRowDirty(this.cursorRow);
        this.pendingWrap = false;
        this._indexDown();
        this._markRowDirty(this.cursorRow);
    }

    nextLine() {
        this._markRowDirty(this.cursorRow);
        this.cursorCol = 0;
        this.pendingWrap = false;
        this._indexDown();
        this._markRowDirty(this.cursorRow);
    }

    reverseIndex() {
        this._markRowDirty(this.cursorRow);
        this.pendingWrap = false;
        if (this.cursorRow === this.scrollTop) {
            this.scrollDown(1);
        } else if (this.cursorRow > 0) {
            this.cursorRow--;
        }
        this._markRowDirty(this.cursorRow);
    }

    backspace() {
        this._markRowDirty(this.cursorRow);
        if (this.pendingWrap) {
            this.pendingWrap = false;
        } else if (this.cursorCol > 0) {
            this.cursorCol--;
        }
        this._markRowDirty(this.cursorRow);
    }

    tab() {
        this._markRowDirty(this.cursorRow);
        const nextStop = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        this.cursorCol = nextStop;
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    _indexDown() {
        if (this.cursorRow === this.scrollBottom) {
            this.scrollUp(1);
        } else if (this.cursorRow < this.rows - 1) {
            this.cursorRow++;
        }
    }

    scrollUp(count = 1, top = this.scrollTop, bottom = this.scrollBottom) {
        const g = this.grid;
        const n = Math.min(count, bottom - top + 1);
        for (let i = 0; i < n; i++) {
            const removed = g[top];
            if (!this.isAltScreen && top === 0 && this.maxScrollback > 0) {
                this.scrollback.push(removed.map(cloneCell));
                if (this.scrollback.length > this.maxScrollback) {
                    this.scrollback.shift();
                }
            }
            for (let r = top; r < bottom; r++) {
                g[r] = g[r + 1];
            }
            g[bottom] = this._createRow(this.cols, true);
        }
        this._markRangeDirty(top, bottom);
    }

    scrollDown(count = 1, top = this.scrollTop, bottom = this.scrollBottom) {
        const g = this.grid;
        const n = Math.min(count, bottom - top + 1);
        for (let i = 0; i < n; i++) {
            for (let r = bottom; r > top; r--) {
                g[r] = g[r - 1];
            }
            g[top] = this._createRow(this.cols, true);
        }
        this._markRangeDirty(top, bottom);
    }

    eraseInLine(mode = 0) {
        const row = this.grid[this.cursorRow];
        if (!row) return;
        let start = 0;
        let end = this.cols - 1;
        if (mode === 0) {
            start = this.cursorCol;
        } else if (mode === 1) {
            end = this.cursorCol;
        } else if (mode !== 2) {
            return;
        }
        for (let c = start; c <= end; c++) {
            row[c] = createCell(' ', this.curFg, this.curBg, this.curFlags, null);
        }
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    eraseInDisplay(mode = 0) {
        const g = this.grid;
        if (mode === 0) {
            this.eraseInLine(0);
            for (let r = this.cursorRow + 1; r < this.rows; r++) {
                g[r] = this._createRow(this.cols, true);
            }
            this._markRangeDirty(this.cursorRow, this.rows - 1);
        } else if (mode === 1) {
            for (let r = 0; r < this.cursorRow; r++) {
                g[r] = this._createRow(this.cols, true);
            }
            this.eraseInLine(1);
            this._markRangeDirty(0, this.cursorRow);
        } else if (mode === 2 || mode === 3) {
            for (let r = 0; r < this.rows; r++) {
                g[r] = this._createRow(this.cols, true);
            }
            if (mode === 3 && !this.isAltScreen) {
                this.scrollback = [];
                this.viewportOffset = 0;
            }
            this.pendingWrap = false;
            this._markAllDirty();
        }
    }

    eraseChars(count = 1) {
        const row = this.grid[this.cursorRow];
        if (!row) return;
        const end = Math.min(this.cols, this.cursorCol + Math.max(1, count));
        for (let c = this.cursorCol; c < end; c++) {
            row[c] = createCell(' ', this.curFg, this.curBg, this.curFlags, null);
        }
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    insertChars(count = 1) {
        const row = this.grid[this.cursorRow];
        if (!row) return;
        const n = Math.min(this.cols - this.cursorCol, Math.max(1, count));
        for (let c = this.cols - 1; c >= this.cursorCol + n; c--) {
            row[c] = row[c - n];
        }
        for (let c = this.cursorCol; c < this.cursorCol + n; c++) {
            row[c] = createCell(' ', this.curFg, this.curBg, this.curFlags, null);
        }
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    deleteChars(count = 1) {
        const row = this.grid[this.cursorRow];
        if (!row) return;
        const n = Math.min(this.cols - this.cursorCol, Math.max(1, count));
        for (let c = this.cursorCol; c < this.cols - n; c++) {
            row[c] = row[c + n];
        }
        for (let c = this.cols - n; c < this.cols; c++) {
            row[c] = createCell(' ', this.curFg, this.curBg, this.curFlags, null);
        }
        this.pendingWrap = false;
        this._markRowDirty(this.cursorRow);
    }

    insertLines(count = 1) {
        if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
        this.scrollDown(Math.max(1, count), this.cursorRow, this.scrollBottom);
        this.cursorCol = 0;
        this.pendingWrap = false;
    }

    deleteLines(count = 1) {
        if (this.cursorRow < this.scrollTop || this.cursorRow > this.scrollBottom) return;
        this.scrollUp(Math.max(1, count), this.cursorRow, this.scrollBottom);
        this.cursorCol = 0;
        this.pendingWrap = false;
    }

    resize(newCols, newRows) {
        const cols = Math.max(1, newCols);
        const rows = Math.max(1, newRows);
        if (cols === this.cols && rows === this.rows) return;

        const resizeGrid = (oldGrid) => {
            const nextGrid = new Array(rows);
            for (let r = 0; r < rows; r++) {
                const newRow = new Array(cols);
                const oldRow = r < oldGrid.length ? oldGrid[r] : null;
                for (let c = 0; c < cols; c++) {
                    newRow[c] = oldRow && c < oldRow.length
                        ? oldRow[c]
                        : createCell(' ', null, null, 0, null);
                }
                nextGrid[r] = newRow;
            }
            return nextGrid;
        };

        this.primaryGrid = resizeGrid(this.primaryGrid);
        this.altGrid = resizeGrid(this.altGrid);
        this.cols = cols;
        this.rows = rows;
        this.scrollTop = 0;
        this.scrollBottom = rows - 1;
        this.cursorRow = Math.min(rows - 1, this.cursorRow);
        this.cursorCol = Math.min(cols - 1, this.cursorCol);
        this.pendingWrap = false;
        this._markAllDirty();
    }

    scrollViewport(deltaLines) {
        if (this.isAltScreen) return;
        const maxOffset = this.scrollback.length;
        const next = Math.max(0, Math.min(maxOffset, this.viewportOffset + deltaLines));
        if (next !== this.viewportOffset) {
            this.viewportOffset = next;
            this._markAllDirty();
        }
    }

    getVisibleRow(viewRow) {
        if (this.isAltScreen || this.viewportOffset === 0) {
            return this.grid[viewRow];
        }
        const totalScrollback = this.scrollback.length;
        const startIdx = totalScrollback - this.viewportOffset;
        const idx = startIdx + viewRow;
        if (idx < totalScrollback) {
            return this.scrollback[idx];
        }
        return this.grid[idx - totalScrollback];
    }

    getLineText(row, trimRight = true) {
        const r = this.grid[row];
        if (!r) return '';
        let str = '';
        for (let c = 0; c < r.length; c++) {
            str += r[c].ch;
        }
        return trimRight ? str.replace(/\s+$/, '') : str;
    }

    getScreenText(options = {}) {
        const trimRight = options.trimRight !== false;
        const lines = [];
        for (let r = 0; r < this.rows; r++) {
            lines.push(this.getLineText(r, trimRight));
        }
        return lines.join('\n');
    }

    getScrollbackAndScreenText(options = {}) {
        const trimRight = options.trimRight !== false;
        const lines = [];
        if (!this.isAltScreen) {
            for (const sbRow of this.scrollback) {
                let s = '';
                for (let c = 0; c < sbRow.length; c++) s += sbRow[c].ch;
                lines.push(trimRight ? s.replace(/\s+$/, '') : s);
            }
        }
        for (let r = 0; r < this.rows; r++) {
            lines.push(this.getLineText(r, trimRight));
        }
        return lines.join('\n');
    }
}

export {
    ScreenBuffer,
    ATTR_BOLD,
    ATTR_DIM,
    ATTR_ITALIC,
    ATTR_UNDERLINE,
    ATTR_BLINK,
    ATTR_INVERSE,
    ATTR_HIDDEN,
    ATTR_STRIKE,
    createCell
};
export default ScreenBuffer;

'use strict';

const InteractiveCommand = require('../lib/InteractiveCommand');

// ANSI helpers
const ESC = '\x1b[';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const RESET = '\x1b[0m';
const INVERT = '\x1b[7m';       // reverse video (header/footer bars)
const BOLD = '\x1b[1m';

/**
 * Minimal browser text editor — pico/nano style.
 *
 * Usage:  pico [filename]
 *
 * Keys:
 *   Arrows       — move cursor
 *   Enter        — new line
 *   Backspace    — delete before cursor
 *   Delete       — delete at cursor
 *   ^S           — save
 *   ^X           — exit (prompts to save unsaved changes)
 *   Any char     — insert
 */
class Pico extends InteractiveCommand {
    static get name() { return 'pico'; }

    get requiresFilesystem() { return true; }

    run() {
        this._filename = this.arguments[0] || null;
        this._lines = [''];
        this._cursor = { row: 0, col: 0 };
        this._scrollRow = 0;
        this._modified = false;
        this._status = '';
        this._exitConfirm = false;

        // Load existing file if given
        if (this._filename) {
            try {
                const fs = this.fs || (this.context && this.context.fs);
                const absPath = fs.absolutePath(this._filename);
                const content = fs._getFileRaw(absPath);
                if (typeof content === 'string') {
                    this._lines = content.split('\n');
                    if (this._lines.length === 0) this._lines = [''];
                } else {
                    this._status = `New file: ${this._filename}`;
                }
            } catch(e) {
                this._status = `New file: ${this._filename}`;
            }
        }

        this._render();

        return new Promise(resolve => {
            this._resolve = resolve;
        });
    }

    onInput(key) {
        this._status = '';

        // Exit-confirm mode: ^X to discard, ^S to save-then-exit
        if (this._exitConfirm) {
            if (key === '^X') {
                this._doExit();
                return;
            }
            if (key === '^S') {
                this._save();
                this._doExit();
                return;
            }
            // Any other key cancels the confirm
            this._exitConfirm = false;
            this._render();
            return;
        }

        switch (key) {
            case '^X':
                if (this._modified) {
                    this._exitConfirm = true;
                    this._status = 'Unsaved changes — ^S Save & Exit  ^X Discard  (any key cancel)';
                } else {
                    this._doExit();
                    return;
                }
                break;

            case '^S':
                this._save();
                break;

            case 'ArrowUp':
                if (this._cursor.row > 0) {
                    this._cursor.row--;
                    this._cursor.col = Math.min(this._cursor.col, this._lines[this._cursor.row].length);
                }
                break;

            case 'ArrowDown':
                if (this._cursor.row < this._lines.length - 1) {
                    this._cursor.row++;
                    this._cursor.col = Math.min(this._cursor.col, this._lines[this._cursor.row].length);
                }
                break;

            case 'ArrowLeft':
                if (this._cursor.col > 0) {
                    this._cursor.col--;
                } else if (this._cursor.row > 0) {
                    this._cursor.row--;
                    this._cursor.col = this._lines[this._cursor.row].length;
                }
                break;

            case 'ArrowRight': {
                const lineLen = this._lines[this._cursor.row].length;
                if (this._cursor.col < lineLen) {
                    this._cursor.col++;
                } else if (this._cursor.row < this._lines.length - 1) {
                    this._cursor.row++;
                    this._cursor.col = 0;
                }
                break;
            }

            case 'Home':
                this._cursor.col = 0;
                break;

            case 'End':
                this._cursor.col = this._lines[this._cursor.row].length;
                break;

            case 'PageUp': {
                const { rows } = this.terminalSize;
                const contentRows = rows - 3;
                this._cursor.row = Math.max(0, this._cursor.row - contentRows);
                this._cursor.col = Math.min(this._cursor.col, this._lines[this._cursor.row].length);
                break;
            }

            case 'PageDown': {
                const { rows } = this.terminalSize;
                const contentRows = rows - 3;
                this._cursor.row = Math.min(this._lines.length - 1, this._cursor.row + contentRows);
                this._cursor.col = Math.min(this._cursor.col, this._lines[this._cursor.row].length);
                break;
            }

            case 'Enter': {
                const line = this._lines[this._cursor.row];
                this._lines[this._cursor.row] = line.slice(0, this._cursor.col);
                this._lines.splice(this._cursor.row + 1, 0, line.slice(this._cursor.col));
                this._cursor.row++;
                this._cursor.col = 0;
                this._modified = true;
                break;
            }

            case 'Backspace': {
                if (this._cursor.col > 0) {
                    const line = this._lines[this._cursor.row];
                    this._lines[this._cursor.row] = line.slice(0, this._cursor.col - 1) + line.slice(this._cursor.col);
                    this._cursor.col--;
                    this._modified = true;
                } else if (this._cursor.row > 0) {
                    const prevLen = this._lines[this._cursor.row - 1].length;
                    this._lines[this._cursor.row - 1] += this._lines[this._cursor.row];
                    this._lines.splice(this._cursor.row, 1);
                    this._cursor.row--;
                    this._cursor.col = prevLen;
                    this._modified = true;
                }
                break;
            }

            case 'Delete': {
                const line = this._lines[this._cursor.row];
                if (this._cursor.col < line.length) {
                    this._lines[this._cursor.row] = line.slice(0, this._cursor.col) + line.slice(this._cursor.col + 1);
                    this._modified = true;
                } else if (this._cursor.row < this._lines.length - 1) {
                    this._lines[this._cursor.row] += this._lines[this._cursor.row + 1];
                    this._lines.splice(this._cursor.row + 1, 1);
                    this._modified = true;
                }
                break;
            }

            case 'Escape':
                // Absorb escape key
                break;

            case 'Tab': {
                // Insert 4 spaces
                this._insertChar('    ');
                break;
            }

            default:
                // Printable characters
                if (key.length === 1) {
                    this._insertChar(key);
                }
                break;
        }

        this._render();
    }

    _insertChar(ch) {
        const line = this._lines[this._cursor.row];
        this._lines[this._cursor.row] = line.slice(0, this._cursor.col) + ch + line.slice(this._cursor.col);
        this._cursor.col += ch.length;
        this._modified = true;
    }

    _save() {
        if (!this._filename) {
            this._status = 'No filename — use:  pico <filename>';
            return;
        }
        try {
            const fs = this.fs || (this.context && this.context.fs);
            const absPath = fs.absolutePath(this._filename);
            const content = this._lines.join('\n');
            fs.setFileByPath(absPath, content, true);
            this._modified = false;
            this._status = `Saved: ${this._filename}`;
        } catch(e) {
            this._status = `Error saving: ${e.message || e}`;
        }
    }

    _doExit() {
        this.exitCode = 0;
        this._resolve();
    }

    _render() {
        const { cols, rows } = this.terminalSize;
        const contentRows = rows - 3;   // header + status + help bar
        const outputLines = [];

        // ── Header bar ──────────────────────────────────────────────────────
        const title = this._filename
            ? ` pico  ${this._filename}${this._modified ? ' [Modified]' : ''}`
            : ' pico  [New Buffer]';
        outputLines.push(INVERT + this._pad(title, cols) + RESET);

        // ── Scroll adjustment ────────────────────────────────────────────────
        if (this._cursor.row < this._scrollRow) {
            this._scrollRow = this._cursor.row;
        }
        if (this._cursor.row >= this._scrollRow + contentRows) {
            this._scrollRow = this._cursor.row - contentRows + 1;
        }

        // ── Content area ─────────────────────────────────────────────────────
        for (let r = 0; r < contentRows; r++) {
            const lineIdx = this._scrollRow + r;
            if (lineIdx >= this._lines.length) {
                outputLines.push(this._pad('~', cols));
                continue;
            }

            const raw = this._lines[lineIdx];
            // Truncate to visible width
            const visible = raw.slice(0, cols);

            if (lineIdx === this._cursor.row) {
                // Highlight cursor character using reverse video
                const col = Math.min(this._cursor.col, visible.length);
                const before = this._escapeAnsi(visible.slice(0, col));
                const atChar = this._escapeAnsi(col < visible.length ? visible[col] : ' ');
                const after  = this._escapeAnsi(visible.slice(col + 1));
                const lineStr = before + INVERT + atChar + RESET + after;
                // Pad to cols with plain spaces after the content (accounting for cursor block at end of line)
                const renderedLen = before.length + 1 + after.length;
                const padding = ' '.repeat(Math.max(0, cols - renderedLen));
                outputLines.push(lineStr + padding);
            } else {
                outputLines.push(this._escapeAnsi(this._pad(visible, cols)));
            }
        }

        // ── Status bar ────────────────────────────────────────────────────────
        const statusText = this._status
            ? this._status
            : `Line ${this._cursor.row + 1}/${this._lines.length}  Col ${this._cursor.col + 1}`;
        outputLines.push(this._pad(statusText, cols));

        // ── Help bar ──────────────────────────────────────────────────────────
        const help = BOLD + '^X' + RESET + ' Exit  ' + BOLD + '^S' + RESET + ' Save';
        const helpPlain = '^X Exit  ^S Save';
        // Pad based on plain length since ANSI codes add no visible width
        const helpPadded = help + ' '.repeat(Math.max(0, cols - helpPlain.length));
        outputLines.push(INVERT + helpPadded + RESET);

        // ── Emit ──────────────────────────────────────────────────────────────
        this.stdOut = CLEAR_SCREEN + outputLines.join('\n');
        this.flush();
    }

    /** Pad or truncate a plain string to exactly `width` characters. */
    _pad(str, width) {
        if (str.length >= width) return str.slice(0, width);
        return str + ' '.repeat(width - str.length);
    }

    /**
     * Escape characters that would be interpreted as ANSI sequences or HTML.
     * We only need to protect against accidental `\x1b` in file content.
     */
    _escapeAnsi(str) {
        // Replace ESC with a visible indicator so file content can't inject sequences
        return str.replace(/\x1b/g, '\u241b');
    }
}

module.exports = Pico;

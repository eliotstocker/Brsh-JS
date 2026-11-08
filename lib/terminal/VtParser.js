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

const STATE_GROUND = 0;
const STATE_ESC = 1;
const STATE_ESC_INTERMEDIATE = 2;
const STATE_CSI = 3;
const STATE_OSC = 4;
const STATE_DCS = 5;

// DEC Special Graphics Character Set (VT100 ACS line drawing)
const DEC_SPECIAL_GRAPHICS = {
    '`': '◆',
    a: '▒',
    f: '°',
    g: '±',
    j: '┘',
    k: '┐',
    l: '┌',
    m: '└',
    n: '┼',
    o: '⎺',
    p: '⎻',
    q: '─',
    r: '⎼',
    s: '⎽',
    t: '├',
    u: '┤',
    v: '┴',
    w: '┬',
    x: '│',
    y: '≤',
    z: '≥',
    '{': 'π',
    '|': '≠',
    '}': '£',
    '~': '·'
};

const DEFAULT_URL_WHITELIST = {
    http: true,
    https: true,
    tel: true,
    mailto: true
};

function sanitizeUrl(url, whitelist = DEFAULT_URL_WHITELIST) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!match) return null;
    const scheme = match[1].toLowerCase();
    if (!whitelist[scheme]) return null;
    return trimmed;
}

class VtParser {
    constructor(screen, options = {}) {
        this.screen = screen;
        this.onResponse = options.onResponse || null;
        this.onTitle = options.onTitle || null;
        this.onBell = options.onBell || null;
        this.urlWhitelist = options.urlWhitelist || DEFAULT_URL_WHITELIST;

        this.state = STATE_GROUND;
        this._csiPrefix = '';
        this._csiParams = '';
        this._csiIntermediate = '';
        this._escIntermediate = '';
        this._oscBuffer = '';
        this._oscEscSeen = false;
        this._dcsEscSeen = false;
        this._lastPrintedChar = ' ';

        // Character set state: 'B' = ASCII, '0' = DEC Special Graphics
        this.charsetG0 = 'B';
        this.charsetG1 = 'B';
        this.activeCharset = 0; // 0 = G0, 1 = G1

        // Terminal mode flags
        this.applicationCursorKeys = false; // ?1
        this.applicationKeypad = false;     // ESC = / ESC >
        this.bracketedPasteMode = false;    // ?2004
        this.mouseTrackingMode = 0;         // 0=off, 1000=normal, 1002=button, 1003=any
        this.mouseProtocol = 'x10';         // 'x10' | 'utf8' (1005) | 'sgr' (1006)
        this.alternateScrollMode = false;   // ?1007
    }

    reset() {
        this.state = STATE_GROUND;
        this._csiPrefix = '';
        this._csiParams = '';
        this._csiIntermediate = '';
        this._escIntermediate = '';
        this._oscBuffer = '';
        this._oscEscSeen = false;
        this._dcsEscSeen = false;
        this._lastPrintedChar = ' ';
        this.charsetG0 = 'B';
        this.charsetG1 = 'B';
        this.activeCharset = 0;
        this.applicationCursorKeys = false;
        this.applicationKeypad = false;
        this.bracketedPasteMode = false;
        this.mouseTrackingMode = 0;
        this.mouseProtocol = 'x10';
        this.alternateScrollMode = false;
        this.screen.reset();
    }

    write(data) {
        if (data == null) return;
        const str = typeof data === 'string'
            ? data
            : (data instanceof Uint8Array || Buffer.isBuffer(data))
                ? new TextDecoder().decode(data)
                : String(data);

        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            const code = str.charCodeAt(i);

            switch (this.state) {
                case STATE_GROUND:
                    this._handleGround(ch, code);
                    break;
                case STATE_ESC:
                    this._handleEsc(ch, code);
                    break;
                case STATE_ESC_INTERMEDIATE:
                    this._handleEscIntermediate(ch, code);
                    break;
                case STATE_CSI:
                    this._handleCsi(ch, code);
                    break;
                case STATE_OSC:
                    this._handleOsc(ch, code);
                    break;
                case STATE_DCS:
                    this._handleDcs(ch, code);
                    break;
            }
        }
    }

    _handleGround(ch, code) {
        if (code === 0x1b) { // ESC
            this.state = STATE_ESC;
            this._escIntermediate = '';
            return;
        }
        if (code === 0x0d) { // CR (\r)
            this.screen.carriageReturn();
            return;
        }
        if (code === 0x0a || code === 0x0b || code === 0x0c) { // LF, VT, FF
            this.screen.lineFeed();
            return;
        }
        if (code === 0x08) { // BS (\b)
            this.screen.backspace();
            return;
        }
        if (code === 0x09) { // HT (\t)
            this.screen.tab();
            return;
        }
        if (code === 0x07) { // BEL
            if (this.onBell) this.onBell();
            return;
        }
        if (code === 0x0e) { // SO (Shift Out -> G1)
            this.activeCharset = 1;
            return;
        }
        if (code === 0x0f) { // SI (Shift In -> G0)
            this.activeCharset = 0;
            return;
        }
        if (code < 0x20 || code === 0x7f) {
            return;
        }

        const charset = this.activeCharset === 0 ? this.charsetG0 : this.charsetG1;
        const mapped = (charset === '0' && DEC_SPECIAL_GRAPHICS[ch]) ? DEC_SPECIAL_GRAPHICS[ch] : ch;
        this._lastPrintedChar = mapped;
        this.screen.putChar(mapped);
    }

    _handleEsc(ch, code) {
        if (ch === '[') {
            this.state = STATE_CSI;
            this._csiPrefix = '';
            this._csiParams = '';
            this._csiIntermediate = '';
            return;
        }
        if (ch === ']') {
            this.state = STATE_OSC;
            this._oscBuffer = '';
            this._oscEscSeen = false;
            return;
        }
        if (ch === 'P' || ch === 'X' || ch === '^' || ch === '_') {
            // DCS, SOS, PM, APC strings — consume until ST (ESC \)
            this.state = STATE_DCS;
            this._dcsEscSeen = false;
            return;
        }
        if (ch === '(' || ch === ')' || ch === '*' || ch === '+' || ch === '#') {
            this.state = STATE_ESC_INTERMEDIATE;
            this._escIntermediate = ch;
            return;
        }
        if (ch === '7') {
            this.screen.saveCursor();
            this.state = STATE_GROUND;
            return;
        }
        if (ch === '8') {
            this.screen.restoreCursor();
            this.state = STATE_GROUND;
            return;
        }
        if (ch === 'D') { // IND (Index)
            this.screen.index();
            this.state = STATE_GROUND;
            return;
        }
        if (ch === 'M') { // RI (Reverse Index)
            this.screen.reverseIndex();
            this.state = STATE_GROUND;
            return;
        }
        if (ch === 'E') { // NEL (Next Line)
            this.screen.nextLine();
            this.state = STATE_GROUND;
            return;
        }
        if (ch === 'c') { // RIS (Full Reset)
            this.reset();
            return;
        }
        if (ch === '=') { // DECKPAM
            this.applicationKeypad = true;
            this.state = STATE_GROUND;
            return;
        }
        if (ch === '>') { // DECKPNM
            this.applicationKeypad = false;
            this.state = STATE_GROUND;
            return;
        }
        if (code === 0x1b) {
            // Remain in ESC state
            return;
        }
        this.state = STATE_GROUND;
    }

    _handleEscIntermediate(ch) {
        if (this._escIntermediate === '(') {
            this.charsetG0 = ch === '0' ? '0' : 'B';
        } else if (this._escIntermediate === ')') {
            this.charsetG1 = ch === '0' ? '0' : 'B';
        } else if (this._escIntermediate === '#' && ch === '8') {
            // DECALN screen alignment test (fills screen with 'E')
            for (let r = 0; r < this.screen.rows; r++) {
                for (let c = 0; c < this.screen.cols; c++) {
                    this.screen.grid[r][c].ch = 'E';
                }
            }
            this.screen._markAllDirty();
        }
        this.state = STATE_GROUND;
    }

    _handleCsi(ch, code) {
        // C0 controls inside CSI are executed immediately in VT100
        if (code === 0x0d) {
            this.screen.carriageReturn();
            return;
        }
        if (code === 0x0a || code === 0x0b || code === 0x0c) {
            this.screen.lineFeed();
            return;
        }
        if (code === 0x08) {
            this.screen.backspace();
            return;
        }
        if (code === 0x1b) {
            this.state = STATE_ESC;
            return;
        }

        // Prefix bytes: ? > < =
        if (this._csiParams.length === 0 && this._csiPrefix.length === 0 && (ch === '?' || ch === '>' || ch === '<' || ch === '=')) {
            this._csiPrefix = ch;
            return;
        }

        // Parameter bytes: digits, ;, :
        if ((code >= 0x30 && code <= 0x39) || ch === ';' || ch === ':') {
            this._csiParams += ch;
            return;
        }

        // Intermediate bytes: 0x20..0x2f
        if (code >= 0x20 && code <= 0x2f) {
            this._csiIntermediate += ch;
            return;
        }

        // Final byte: 0x40..0x7e
        if (code >= 0x40 && code <= 0x7e) {
            this._dispatchCsi(this._csiPrefix, this._csiParams, this._csiIntermediate, ch);
            this.state = STATE_GROUND;
        }
    }

    _handleOsc(ch, code) {
        if (code === 0x07) { // BEL terminates OSC
            this._dispatchOsc(this._oscBuffer);
            this.state = STATE_GROUND;
            return;
        }
        if (this._oscEscSeen) {
            this._oscEscSeen = false;
            if (ch === '\\') { // ST (ESC \) terminates OSC
                this._dispatchOsc(this._oscBuffer);
                this.state = STATE_GROUND;
                return;
            }
            this._oscBuffer += '\x1b' + ch;
            return;
        }
        if (code === 0x1b) {
            this._oscEscSeen = true;
            return;
        }
        this._oscBuffer += ch;
    }

    _handleDcs(ch, code) {
        if (code === 0x07) {
            this.state = STATE_GROUND;
            return;
        }
        if (this._dcsEscSeen) {
            this._dcsEscSeen = false;
            if (ch === '\\') {
                this.state = STATE_GROUND;
                return;
            }
        }
        if (code === 0x1b) {
            this._dcsEscSeen = true;
        }
    }

    _dispatchOsc(raw) {
        const semi = raw.indexOf(';');
        if (semi === -1) return;
        const cmd = raw.slice(0, semi);
        const payload = raw.slice(semi + 1);

        if (cmd === '0' || cmd === '2') {
            if (this.onTitle) this.onTitle(payload);
        } else if (cmd === '8') {
            // OSC 8 ; params ; URI
            const nextSemi = payload.indexOf(';');
            if (nextSemi !== -1) {
                const uri = payload.slice(nextSemi + 1);
                this.screen.curLink = uri ? sanitizeUrl(uri, this.urlWhitelist) : null;
            }
        }
    }

    _parseParams(paramStr) {
        if (!paramStr) return [];
        return paramStr.split(';').map(p => {
            if (p.includes(':')) {
                return p.split(':').map(sp => (sp === '' ? 0 : parseInt(sp, 10) || 0));
            }
            return p === '' ? 0 : parseInt(p, 10) || 0;
        });
    }

    _dispatchCsi(prefix, paramStr, intermediate, final) {
        const params = this._parseParams(paramStr);
        const p0 = typeof params[0] === 'number' ? params[0] : 0;
        const p1 = typeof params[1] === 'number' ? params[1] : 0;

        if (prefix === '?') {
            this._dispatchDecPrivate(params, final);
            return;
        }

        if (prefix === '>') {
            if (final === 'c' && this.onResponse) {
                this.onResponse('\x1b[>0;276;0c');
            }
            return;
        }

        switch (final) {
            case 'A': // CUU - Cursor Up
                this.screen.moveCursorRelative(-Math.max(1, p0), 0);
                break;
            case 'B': // CUD - Cursor Down
            case 'e':
                this.screen.moveCursorRelative(Math.max(1, p0), 0);
                break;
            case 'C': // CUF - Cursor Forward
            case 'a':
                this.screen.moveCursorRelative(0, Math.max(1, p0));
                break;
            case 'D': // CUB - Cursor Back
                this.screen.moveCursorRelative(0, -Math.max(1, p0));
                break;
            case 'E': // CNL - Cursor Next Line
                this.screen.moveCursorRelative(Math.max(1, p0), 0);
                this.screen.carriageReturn();
                break;
            case 'F': // CPL - Cursor Previous Line
                this.screen.moveCursorRelative(-Math.max(1, p0), 0);
                this.screen.carriageReturn();
                break;
            case 'G': // CHA - Cursor Horizontal Absolute
            case '`':
                this.screen.setCursor(this.screen.cursorRow, Math.max(1, p0) - 1);
                break;
            case 'H': // CUP - Cursor Position
            case 'f':
                this.screen.setCursor(Math.max(1, p0) - 1, Math.max(1, p1) - 1);
                break;
            case 'd': // VPA - Vertical Position Absolute
                this.screen.setCursor(Math.max(1, p0) - 1, this.screen.cursorCol);
                break;
            case 'J': // ED - Erase in Display
                this.screen.eraseInDisplay(p0);
                break;
            case 'K': // EL - Erase in Line
                this.screen.eraseInLine(p0);
                break;
            case 'X': // ECH - Erase Characters
                this.screen.eraseChars(Math.max(1, p0));
                break;
            case '@': // ICH - Insert Blank Characters
                this.screen.insertChars(Math.max(1, p0));
                break;
            case 'P': // DCH - Delete Characters
                this.screen.deleteChars(Math.max(1, p0));
                break;
            case 'L': // IL - Insert Lines
                this.screen.insertLines(Math.max(1, p0));
                break;
            case 'M': // DL - Delete Lines
                this.screen.deleteLines(Math.max(1, p0));
                break;
            case 'S': // SU - Scroll Up
                this.screen.scrollUp(Math.max(1, p0));
                break;
            case 'T': // SD - Scroll Down
                this.screen.scrollDown(Math.max(1, p0));
                break;
            case 'r': // DECSTBM - Set Top and Bottom Margins
                this.screen.setScrollRegion(p0 || 1, p1 || this.screen.rows);
                break;
            case 's': // SCOSC - Save Cursor
                this.screen.saveCursor();
                break;
            case 'u': // SCORC - Restore Cursor
                this.screen.restoreCursor();
                break;
            case 'b': { // REP - Repeat preceding graphic character
                const count = Math.min(this.screen.cols * this.screen.rows, Math.max(1, p0));
                for (let i = 0; i < count; i++) {
                    this.screen.putChar(this._lastPrintedChar);
                }
                break;
            }
            case 'm': // SGR - Select Graphic Rendition
                this._handleSgr(params);
                break;
            case 'h': // SM - Set Mode
            case 'l': // RM - Reset Mode
                if (p0 === 20) {
                    this.screen.convertEol = (final === 'h');
                }
                break;
            case 'n': // DSR - Device Status Report
                if (this.onResponse) {
                    if (p0 === 5) {
                        this.onResponse('\x1b[0n');
                    } else if (p0 === 6) {
                        this.onResponse(`\x1b[${this.screen.cursorRow + 1};${this.screen.cursorCol + 1}R`);
                    }
                }
                break;
            case 'c': // DA1 - Primary Device Attributes
                if (this.onResponse) {
                    this.onResponse('\x1b[?1;2c');
                }
                break;
            case 't': // XTWINOPS
                if (p0 === 18 && this.onResponse) {
                    this.onResponse(`\x1b[8;${this.screen.rows};${this.screen.cols}t`);
                }
                break;
        }
    }

    _dispatchDecPrivate(params, final) {
        if (final === 'c' && this.onResponse) {
            this.onResponse('\x1b[?1;2c');
            return;
        }
        if (final !== 'h' && final !== 'l') return;
        const enable = final === 'h';

        for (const p of params) {
            const mode = typeof p === 'number' ? p : 0;
            switch (mode) {
                case 1: // DECCKM - Application Cursor Keys
                    this.applicationCursorKeys = enable;
                    break;
                case 6: // DECOM - Origin Mode
                    this.screen.originMode = enable;
                    this.screen.setCursor(0, 0);
                    break;
                case 7: // DECAWM - Auto-Wrap Mode
                    this.screen.autoWrap = enable;
                    break;
                case 25: // DECTCEM - Text Cursor Enable
                    this.screen.cursorVisible = enable;
                    this.screen._markRowDirty(this.screen.cursorRow);
                    break;
                case 47:
                case 1047:
                    if (enable) {
                        this.screen.enterAltScreen(mode === 1047);
                    } else {
                        this.screen.exitAltScreen();
                    }
                    break;
                case 1048:
                    if (enable) {
                        this.screen.saveCursor();
                    } else {
                        this.screen.restoreCursor();
                    }
                    break;
                case 1049:
                    if (enable) {
                        this.screen.saveCursor();
                        this.screen.enterAltScreen(true);
                    } else {
                        this.screen.exitAltScreen();
                        this.screen.restoreCursor();
                    }
                    break;
                case 1000:
                case 1002:
                case 1003:
                    if (enable) {
                        this.mouseTrackingMode = mode;
                    } else if (this.mouseTrackingMode === mode) {
                        this.mouseTrackingMode = 0;
                    }
                    break;
                case 1005:
                    this.mouseProtocol = enable ? 'utf8' : 'x10';
                    break;
                case 1006:
                    this.mouseProtocol = enable ? 'sgr' : 'x10';
                    break;
                case 1007:
                    this.alternateScrollMode = enable;
                    break;
                case 2004:
                    this.bracketedPasteMode = enable;
                    break;
            }
        }
    }

    _handleSgr(params) {
        if (params.length === 0) {
            this.screen.resetAttributes();
            return;
        }

        let i = 0;
        while (i < params.length) {
            const p = params[i];

            // Handle colon-separated subparams (e.g. [38, 5, n] or [38, 2, cs, r, g, b])
            if (Array.isArray(p)) {
                const head = p[0];
                if (head === 38 || head === 48) {
                    const isFg = head === 38;
                    if (p[1] === 5 && p.length >= 3) {
                        if (isFg) this.screen.curFg = p[2];
                        else this.screen.curBg = p[2];
                    } else if (p[1] === 2 && p.length >= 5) {
                        const offset = p.length >= 6 ? 3 : 2;
                        const color = `rgb(${p[offset] || 0}, ${p[offset + 1] || 0}, ${p[offset + 2] || 0})`;
                        if (isFg) this.screen.curFg = color;
                        else this.screen.curBg = color;
                    }
                }
                i++;
                continue;
            }

            switch (p) {
                case 0:
                    this.screen.resetAttributes();
                    break;
                case 1:
                    this.screen.curFlags |= ATTR_BOLD;
                    break;
                case 2:
                    this.screen.curFlags |= ATTR_DIM;
                    break;
                case 3:
                    this.screen.curFlags |= ATTR_ITALIC;
                    break;
                case 4:
                    this.screen.curFlags |= ATTR_UNDERLINE;
                    break;
                case 5:
                case 6:
                    this.screen.curFlags |= ATTR_BLINK;
                    break;
                case 7:
                    this.screen.curFlags |= ATTR_INVERSE;
                    break;
                case 8:
                    this.screen.curFlags |= ATTR_HIDDEN;
                    break;
                case 9:
                    this.screen.curFlags |= ATTR_STRIKE;
                    break;
                case 21:
                case 22:
                    this.screen.curFlags &= ~(ATTR_BOLD | ATTR_DIM);
                    break;
                case 23:
                    this.screen.curFlags &= ~ATTR_ITALIC;
                    break;
                case 24:
                    this.screen.curFlags &= ~ATTR_UNDERLINE;
                    break;
                case 25:
                    this.screen.curFlags &= ~ATTR_BLINK;
                    break;
                case 27:
                    this.screen.curFlags &= ~ATTR_INVERSE;
                    break;
                case 28:
                    this.screen.curFlags &= ~ATTR_HIDDEN;
                    break;
                case 29:
                    this.screen.curFlags &= ~ATTR_STRIKE;
                    break;
                case 38:
                case 48: {
                    const isFg = p === 38;
                    const mode = params[i + 1];
                    if (mode === 5 && i + 2 < params.length) {
                        const colorIdx = Number(params[i + 2]) || 0;
                        if (isFg) this.screen.curFg = colorIdx;
                        else this.screen.curBg = colorIdx;
                        i += 2;
                    } else if (mode === 2 && i + 4 < params.length) {
                        const r = Number(params[i + 2]) || 0;
                        const g = Number(params[i + 3]) || 0;
                        const b = Number(params[i + 4]) || 0;
                        const rgb = `rgb(${r}, ${g}, ${b})`;
                        if (isFg) this.screen.curFg = rgb;
                        else this.screen.curBg = rgb;
                        i += 4;
                    }
                    break;
                }
                case 39:
                    this.screen.curFg = null;
                    break;
                case 49:
                    this.screen.curBg = null;
                    break;
                default:
                    if (p >= 30 && p <= 37) {
                        this.screen.curFg = p - 30;
                    } else if (p >= 40 && p <= 47) {
                        this.screen.curBg = p - 40;
                    } else if (p >= 90 && p <= 97) {
                        this.screen.curFg = p - 90 + 8;
                    } else if (p >= 100 && p <= 107) {
                        this.screen.curBg = p - 100 + 8;
                    }
                    break;
            }
            i++;
        }
    }
}

export {
    VtParser,
    DEC_SPECIAL_GRAPHICS,
    sanitizeUrl,
    DEFAULT_URL_WHITELIST
};
export default VtParser;

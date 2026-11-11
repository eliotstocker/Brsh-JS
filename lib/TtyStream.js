'use strict';

const events = require('events');
const EventEmitter = events.EventEmitter || events.default || events;

function parseVtKeys(seq) {
    if (!seq) return [];
    const str = typeof seq === 'string'
        ? seq
        : (seq instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(seq)))
            ? new TextDecoder().decode(seq)
            : String(seq);

    const keys = [];
    let i = 0;

    while (i < str.length) {
        const ch = str[i];
        const code = str.charCodeAt(i);

        if (code === 0x1b) {
            if (str.charCodeAt(i + 1) === 0x7f || str.charCodeAt(i + 1) === 0x08) {
                keys.push('^W');
                i += 2;
                continue;
            }
            if (str[i + 1] === '[' || str[i + 1] === 'O') {
                let j = i + 2;
                while (j < str.length && str.charCodeAt(j) >= 0x20 && str.charCodeAt(j) <= 0x3f) {
                    j++;
                }
                if (j < str.length) {
                    const body = str.slice(i + 2, j + 1);
                    const map = {
                        A: 'ArrowUp',
                        B: 'ArrowDown',
                        C: 'ArrowRight',
                        D: 'ArrowLeft',
                        H: 'Home',
                        F: 'End',
                        Z: 'BackTab',
                        P: 'F1',
                        Q: 'F2',
                        R: 'F3',
                        S: 'F4',
                        '1~': 'Home',
                        '2~': 'Insert',
                        '3~': 'Delete',
                        '4~': 'End',
                        '5~': 'PageUp',
                        '6~': 'PageDown',
                        '7~': 'Home',
                        '8~': 'End',
                        '15~': 'F5',
                        '17~': 'F6',
                        '18~': 'F7',
                        '19~': 'F8',
                        '20~': 'F9',
                        '21~': 'F10',
                        '23~': 'F11',
                        '24~': 'F12'
                    };
                    if (map[body]) {
                        keys.push(map[body]);
                    } else {
                        const modCursor = body.match(/^1;\d+([ABCDHF])$/);
                        if (modCursor && map[modCursor[1]]) {
                            keys.push(map[modCursor[1]]);
                        }
                    }
                    i = j + 1;
                    continue;
                }
            }
            keys.push('Escape');
            i++;
            continue;
        }

        if (code === 0x0d || code === 0x0a) {
            keys.push('Enter');
            if (code === 0x0d && str[i + 1] === '\n') i++;
            i++;
            continue;
        }
        if (code === 0x7f || code === 0x08) {
            keys.push('Backspace');
            i++;
            continue;
        }
        if (code === 0x09) {
            keys.push('Tab');
            i++;
            continue;
        }
        if (code >= 0x01 && code <= 0x1a) {
            keys.push('^' + String.fromCharCode(code + 0x40));
            i++;
            continue;
        }
        keys.push(ch);
        i++;
    }
    return keys;
}

class TtyStream extends EventEmitter {
    constructor(options = {}) {
        super();
        this.isTTY = options.isTTY !== false;
        this.readable = true;
        this.writable = true;
        this.columns = options.columns || 80;
        this.rows = options.rows || 24;
        this.isRaw = false;
        this._encoding = null;
        this._onWrite = options.onWrite || null;
    }

    write(chunk, encoding, callback) {
        if (chunk == null) return true;
        if (typeof this._onWrite === 'function') {
            this._onWrite(chunk);
        }
        this._isPushing = true;
        try {
            this.emit('data', this._formatChunk(chunk));
        } finally {
            this._isPushing = false;
        }
        if (typeof encoding === 'function') encoding();
        else if (typeof callback === 'function') callback();
        return true;
    }

    pushData(chunk) {
        if (chunk == null) return;
        this._isPushing = true;
        try {
            this.emit('data', this._formatChunk(chunk));
        } finally {
            this._isPushing = false;
        }
    }

    _formatChunk(chunk) {
        if (this._encoding) {
            if (typeof chunk === 'string') return chunk;
            if (chunk instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk))) {
                return new TextDecoder().decode(chunk);
            }
            return String(chunk);
        }
        return chunk;
    }

    setRawMode(flag) {
        this.isRaw = Boolean(flag);
        return this;
    }

    setEncoding(enc) {
        this._encoding = enc;
        return this;
    }

    getWindowSize() {
        return [this.columns, this.rows];
    }

    resize(cols, rows) {
        this.columns = cols;
        this.rows = rows;
        this.emit('resize');
    }

    resume() { return this; }
    pause() { return this; }
    pipe(dest) {
        this.on('data', chunk => dest.write(chunk));
        return dest;
    }
    unpipe() { return this; }
    end(chunk, encoding, cb) {
        if (chunk != null) {
            this.write(chunk, typeof encoding === 'string' ? encoding : undefined);
        }
        this.emit('end');
        if (typeof encoding === 'function') encoding();
        else if (typeof cb === 'function') cb();
        return this;
    }

    destroy() {
        this.removeAllListeners();
    }

    toString() {
        return '';
    }

    valueOf() {
        return '';
    }
}

function hasCustomStdinListener(cmd) {
    if (!cmd || cmd._managesOwnStdinCapture || !cmd.stdinStream || typeof cmd.stdinStream.listenerCount !== 'function') {
        return false;
    }
    const count = cmd.stdinStream.listenerCount('data');
    if (count === 0) return false;
    if (cmd._onStdinStreamData && typeof cmd.stdinStream.listeners === 'function') {
        const hasDefault = cmd.stdinStream.listeners('data').includes(cmd._onStdinStreamData);
        return count > (hasDefault ? 1 : 0);
    }
    return count > 0;
}

module.exports = {
    TtyStream,
    parseVtKeys,
    hasCustomStdinListener
};


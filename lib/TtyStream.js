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
                        '1~': 'Home',
                        '3~': 'Delete',
                        '4~': 'End',
                        '5~': 'PageUp',
                        '6~': 'PageDown',
                        '7~': 'Home',
                        '8~': 'End'
                    };
                    if (map[body]) {
                        keys.push(map[body]);
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
        this.emit('data', this._formatChunk(chunk));
        if (typeof encoding === 'function') encoding();
        else if (typeof callback === 'function') callback();
        return true;
    }

    pushData(chunk) {
        if (chunk == null) return;
        this.emit('data', this._formatChunk(chunk));
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

module.exports = {
    TtyStream,
    parseVtKeys
};

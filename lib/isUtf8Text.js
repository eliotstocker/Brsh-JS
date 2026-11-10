'use strict';

/**
 * Checks whether a byte buffer contains valid UTF-8/ASCII text.
 * Returns true if the buffer is text, false if it should be treated as binary.
 *
 * Rules:
 * - Empty buffers are considered valid text.
 * - Checks for NUL bytes (0x00) or non-printable ASCII control characters.
 *   Valid text allows tabs (\t, 0x09), line feeds (\n, 0x0A), carriage returns (\r, 0x0D),
 *   and ANSI escape sequences (ESC, 0x1B).
 *   Characters 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1A, 0x1C-0x1F are treated as binary.
 * - Uses TextDecoder('utf-8', { fatal: true }) to verify strict UTF-8 validity.
 */
function isUtf8Text(buf) {
    if (!buf || buf.length === 0) return true;

    const u8 = buf instanceof Uint8Array
        ? buf
        : (typeof Buffer !== 'undefined' && Buffer.isBuffer(buf))
            ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
            : (buf instanceof ArrayBuffer || ArrayBuffer.isView(buf))
                ? new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength)
                : null;

    if (!u8) return false;

    // Fast check first 8KB (or entire buffer if smaller) for binary control bytes
    const checkLength = Math.min(u8.length, 8192);
    for (let i = 0; i < checkLength; i++) {
        const b = u8[i];
        if (b === 0x00) return false;
        if (b < 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D && b !== 0x1B) {
            return false;
        }
    }

    try {
        new TextDecoder('utf-8', { fatal: true }).decode(u8);
        return true;
    } catch {
        return false;
    }
}

module.exports = isUtf8Text;
module.exports.isUtf8Text = isUtf8Text;

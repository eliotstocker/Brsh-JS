'use strict';

const { BinaryFile, SymlinkRef } = require('./BaseFileSystem');

// 4-byte magic: "BRFS" (0x42, 0x52, 0x46, 0x53)
const MAGIC = new Uint8Array([0x42, 0x52, 0x46, 0x53]);
const FORMAT_VERSION = 2;

/**
 * Checks whether an ArrayBuffer or Uint8Array starts with the 4-byte "BRFS" magic header.
 */
function isBinaryContainer(input) {
    if (!input) return false;
    const bytes = input instanceof Uint8Array
        ? input
        : (input instanceof ArrayBuffer || ArrayBuffer.isView(input))
            ? new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength)
            : null;
    if (!bytes || bytes.length < 12) return false;
    return (
        bytes[0] === MAGIC[0] &&
        bytes[1] === MAGIC[1] &&
        bytes[2] === MAGIC[2] &&
        bytes[3] === MAGIC[3]
    );
}

/**
 * Serializes a `{ filesystem, permissions, commandsBundle }` structure into a single
 * binary container (`Uint8Array`) with layout:
 *   [0..3]   Magic "BRFS" (4 bytes)
 *   [4..7]   Version (uint32 LE, currently 2)
 *   [8..11]  Header JSON byte length (uint32 LE)
 *   [12..12+headerLen] UTF-8 JSON header: { tree, permissions, hasCommandsBundle }
 *   [12+headerLen..]   Contiguous raw payload bytes (files, strings, optional commands JS bundle)
 *
 * Inside `header.tree`:
 *   - Directories: `{ "$d": { ...children } }` (or plain object without reserved `$` keys)
 *   - Text files:  `{ "$t": [offset, byteLength] }`
 *   - Binary files: `{ "$b": [offset, byteLength, mimeType] }`
 *   - Symlinks:    `{ "$l": targetPath }`
 *   - JS Commands: `{ "$c": commandKey }` (resolved from `commandsBundle` or serialized function)
 */
function serializeBinaryFilesystem(filesystem = {}, permissions = {}, options = {}) {
    const encoder = new TextEncoder();
    const payloadChunks = [];
    let currentOffset = 0;

    const appendPayload = (bytes) => {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const start = currentOffset;
        payloadChunks.push(u8);
        currentOffset += u8.byteLength;
        return [start, u8.byteLength];
    };

    const inlineCommandSources = {};

    const encodeNode = (node, virtualPath) => {
        if (node === null || node === undefined) return null;

        if (node instanceof SymlinkRef) {
            return { $l: node.target };
        }

        if (node instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(node))) {
            const u8 = node instanceof Uint8Array
                ? new Uint8Array(node.buffer, node.byteOffset, node.byteLength)
                : new Uint8Array(node);
            const mime = node.mimeType || (virtualPath.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
            const [off, len] = appendPayload(u8);
            return { $b: [off, len, mime] };
        }

        if (typeof node === 'function') {
            // If an external commandsBundle is provided, reference by virtualPath;
            // otherwise store the function's source code so client-side persistence works standalone!
            if (!options.commandsBundle) {
                inlineCommandSources[virtualPath] = node.toString();
            }
            return { $c: virtualPath };
        }

        if (typeof node === 'string') {
            // Check if string is a data:<mime>;base64,... URI — if so, decode to raw binary!
            if (node.startsWith('data:')) {
                const semi = node.indexOf(';');
                const comma = node.indexOf(',', semi);
                if (semi !== -1 && comma !== -1 && node.slice(semi + 1, comma) === 'base64') {
                    const mime = node.slice(5, semi);
                    const b64 = node.slice(comma + 1);
                    let rawBytes;
                    if (typeof Buffer !== 'undefined') {
                        rawBytes = new Uint8Array(Buffer.from(b64, 'base64'));
                    } else {
                        const bin = atob(b64);
                        rawBytes = new Uint8Array(bin.length);
                        for (let i = 0; i < bin.length; i++) rawBytes[i] = bin.charCodeAt(i);
                    }
                    const [off, len] = appendPayload(rawBytes);
                    return { $b: [off, len, mime] };
                }
            }

            const strBytes = encoder.encode(node);
            const [off, len] = appendPayload(strBytes);
            return { $t: [off, len] };
        }

        if (typeof node === 'object') {
            const children = {};
            for (const key of Object.keys(node)) {
                const childPath = `${virtualPath}/${key}`;
                const encoded = encodeNode(node[key], childPath);
                if (encoded !== null) {
                    children[key] = encoded;
                }
            }
            return { $d: children };
        }

        return null;
    };

    const tree = encodeNode(filesystem, '') || { $d: {} };

    let commandsSlice = null;
    if (options.commandsBundle && typeof options.commandsBundle === 'string') {
        const cmdBytes = encoder.encode(options.commandsBundle);
        commandsSlice = appendPayload(cmdBytes);
    }

    const headerObj = {
        v: FORMAT_VERSION,
        tree,
        permissions: Object.assign({}, permissions),
    };
    if (commandsSlice) {
        headerObj.commandsSlice = commandsSlice;
    }
    if (Object.keys(inlineCommandSources).length > 0) {
        headerObj.inlineCommands = inlineCommandSources;
    }

    const headerBytes = encoder.encode(JSON.stringify(headerObj));
    const totalLength = 12 + headerBytes.byteLength + currentOffset;

    const out = new Uint8Array(totalLength);
    out.set(MAGIC, 0);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(4, FORMAT_VERSION, true);
    view.setUint32(8, headerBytes.byteLength, true);
    out.set(headerBytes, 12);

    let writePos = 12 + headerBytes.byteLength;
    for (const chunk of payloadChunks) {
        out.set(chunk, writePos);
        writePos += chunk.byteLength;
    }

    return out;
}

/**
 * Deserializes a binary container (`Uint8Array` or `ArrayBuffer`) back into
 * `{ filesystem, permissions }` using zero-copy `BinaryFile` subarray views.
 */
function deserializeBinaryFilesystem(input, customCommandMap = {}) {
    const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);

    if (!isBinaryContainer(bytes)) {
        throw new Error('Invalid BRFS binary container (missing BRFS magic header)');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(4, true);
    if (version > FORMAT_VERSION) {
        throw new Error(`Unsupported BRFS container version: ${version}`);
    }

    const headerLen = view.getUint32(8, true);
    const payloadStart = 12 + headerLen;
    if (payloadStart > bytes.byteLength) {
        throw new Error('Corrupt BRFS binary container (header length exceeds buffer)');
    }

    const decoder = new TextDecoder();
    const headerJson = decoder.decode(bytes.subarray(12, payloadStart));
    const header = JSON.parse(headerJson);

    // Ensure we have a clean underlying ArrayBuffer slice for zero-copy BinaryFile views
    const payloadBytes = bytes.subarray(payloadStart);

    let bundledCommands = Object.assign({}, customCommandMap);
    if (Array.isArray(header.commandsSlice)) {
        const [off, len] = header.commandsSlice;
        const jsCode = decoder.decode(payloadBytes.subarray(off, off + len));
        try {
            const evaluated = new Function(jsCode)();
            if (evaluated && typeof evaluated === 'object') {
                Object.assign(bundledCommands, evaluated);
            }
        } catch {
            // ignore bundle evaluation error
        }
    }

    const decodeNode = (entry) => {
        if (!entry || typeof entry !== 'object') return entry;

        if ('$t' in entry) {
            const [off, len] = entry.$t;
            return decoder.decode(payloadBytes.subarray(off, off + len));
        }

        if ('$b' in entry) {
            const [off, len, mime] = entry.$b;
            const slice = payloadBytes.slice(off, off + len);
            return new BinaryFile(slice.buffer, mime || 'application/octet-stream');
        }

        if ('$l' in entry) {
            return new SymlinkRef(entry.$l);
        }

        if ('$c' in entry) {
            const cmdPath = entry.$c;
            if (bundledCommands[cmdPath]) {
                return bundledCommands[cmdPath];
            }
            if (header.inlineCommands && header.inlineCommands[cmdPath]) {
                try {
                    const Command = require('./Command');
                    const InteractiveCommand = require('./InteractiveCommand');
                    const fn = new Function('Command', 'InteractiveCommand', `return (${header.inlineCommands[cmdPath]});`);
                    return fn(Command, InteractiveCommand);
                } catch {
                    return null;
                }
            }
            return null;
        }

        if ('$d' in entry) {
            const dir = {};
            for (const [k, v] of Object.entries(entry.$d)) {
                const decoded = decodeNode(v);
                if (decoded !== null) {
                    dir[k] = decoded;
                }
            }
            return dir;
        }

        return entry;
    };

    const filesystem = decodeNode(header.tree) || {};
    const permissions = Object.assign({}, header.permissions || {});

    return { filesystem, permissions };
}

/**
 * Checks whether a byte buffer starts with the gzip magic header (0x1f 0x8b).
 */
function isGzipBytes(input) {
    if (!input) return false;
    const u8 = input instanceof Uint8Array
        ? input
        : (input instanceof ArrayBuffer ? new Uint8Array(input) : (ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null));
    return Boolean(u8 && u8.byteLength >= 2 && u8[0] === 0x1f && u8[1] === 0x8b);
}

/**
 * Decompresses gzip-compressed bytes in Browser or Node (`DecompressionStream` or `zlib`).
 */
async function decompressGzipBytes(u8) {
    if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const stream = new Blob([u8]).stream().pipeThrough(ds);
        const ab = await new Response(stream).arrayBuffer();
        return new Uint8Array(ab);
    }
    if (typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function') {
        const zlib = process.getBuiltinModule('zlib');
        if (zlib) {
            return new Uint8Array(zlib.gunzipSync(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)));
        }
    }
    throw new Error('Gzip decompression is not supported in this environment');
}

/**
 * Checks whether a `filesystem` option passed to `new Shell({ filesystem })` requires asynchronous resolution
 * (e.g., a URL/file path string, a Promise, a fetch Response, or gzip-compressed bytes).
 */
function isAsyncFilesystemSource(source) {
    if (!source) return false;
    if (typeof source === 'string') return true;
    if (typeof source.then === 'function') return true;
    if (typeof source.arrayBuffer === 'function') return true;
    if (isGzipBytes(source)) return true;
    return false;
}

/**
 * Resolves any filesystem source (URL/path string, Promise, fetch Response, raw or gzipped `.brfs` bytes,
 * or plain `{ filesystem, permissions }` object) into `{ filesystem, permissions }`.
 */
async function resolveFilesystemSource(source, defaultPermissions = {}) {
    if (!source) {
        return { filesystem: {}, permissions: defaultPermissions };
    }

    if (typeof source.then === 'function') {
        const awaited = await source;
        return resolveFilesystemSource(awaited, defaultPermissions);
    }

    if (typeof source.arrayBuffer === 'function') {
        const ab = await source.arrayBuffer();
        return resolveFilesystemSource(new Uint8Array(ab), defaultPermissions);
    }

    if (typeof source === 'string') {
        // In Node.js, support local file paths directly if not an http(s) URL
        if (
            !/^https?:\/\//i.test(source) &&
            typeof process !== 'undefined' &&
            typeof process.getBuiltinModule === 'function' &&
            typeof window === 'undefined'
        ) {
            try {
                const fs = process.getBuiltinModule('fs');
                if (fs && fs.existsSync(source)) {
                    const buf = await fs.promises.readFile(source);
                    return resolveFilesystemSource(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), defaultPermissions);
                }
            } catch (_) {
                // Fall back to fetch() below
            }
        }

        const res = await fetch(source);
        if (!res.ok) {
            throw new Error(`Failed to load filesystem from ${source}: HTTP ${res.status}`);
        }
        const ab = await res.arrayBuffer();
        return resolveFilesystemSource(new Uint8Array(ab), defaultPermissions);
    }

    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
        let u8 = source instanceof Uint8Array
            ? source
            : (source instanceof ArrayBuffer
                ? new Uint8Array(source)
                : new Uint8Array(source.buffer, source.byteOffset, source.byteLength));

        if (isGzipBytes(u8)) {
            u8 = await decompressGzipBytes(u8);
        }

        if (isBinaryContainer(u8)) {
            const unpacked = deserializeBinaryFilesystem(u8);
            return {
                filesystem: unpacked.filesystem,
                permissions: Object.assign({}, unpacked.permissions, defaultPermissions)
            };
        }

        // Legacy compressed JS bundle or JSON text fallback
        const text = new TextDecoder('utf-8').decode(u8);
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && parsed.filesystem && typeof parsed.permissions === 'object') {
                return {
                    filesystem: parsed.filesystem,
                    permissions: Object.assign({}, parsed.permissions, defaultPermissions)
                };
            }
            return { filesystem: parsed, permissions: defaultPermissions };
        } catch (_) {
            const evaluated = new Function('return ' + text)();
            if (evaluated && typeof evaluated === 'object' && evaluated.filesystem && typeof evaluated.permissions === 'object') {
                return {
                    filesystem: evaluated.filesystem,
                    permissions: Object.assign({}, evaluated.permissions, defaultPermissions)
                };
            }
            return { filesystem: evaluated || {}, permissions: defaultPermissions };
        }
    }

    if (typeof source === 'object' && source.filesystem && typeof source.permissions === 'object') {
        if (isAsyncFilesystemSource(source.filesystem) || isBinaryContainer(source.filesystem)) {
            return resolveFilesystemSource(source.filesystem, Object.assign({}, source.permissions, defaultPermissions));
        }
        return {
            filesystem: source.filesystem,
            permissions: Object.assign({}, source.permissions, defaultPermissions)
        };
    }

    return {
        filesystem: source,
        permissions: defaultPermissions
    };
}

/**
 * Browser / Node IndexedDB + OPFS / LocalStorage persistence helper for `brsh` filesystems.
 *
 * Allows saving and restoring the entire `FileSystem` state (including binary `.wasm` files,
 * SQLite `.db` databases, permissions, and symlinks) as a single compact `BRFS` binary blob!
 */
class FilesystemStorage {
    /**
     * Saves a Shell or FileSystem instance's current state into IndexedDB (browser)
     * or returns the binary `Uint8Array` snapshot.
     */
    static async save(shellOrFs, key = 'brsh-rootfs') {
        const fs = shellOrFs.context ? shellOrFs.context.fs : shellOrFs;
        const snapshot = serializeBinaryFilesystem(fs.getRaw(), fs.getRawPermissions());

        if (typeof indexedDB !== 'undefined') {
            await this._idbPut(key, snapshot);
        }
        return snapshot;
    }

    /**
     * Loads a previously saved binary filesystem snapshot from IndexedDB (or from a `Uint8Array` / URL)
     * and returns `{ filesystem, permissions }`.
     */
    static async load(keyOrBytesOrUrl = 'brsh-rootfs') {
        if (keyOrBytesOrUrl instanceof Uint8Array || keyOrBytesOrUrl instanceof ArrayBuffer) {
            return resolveFilesystemSource(keyOrBytesOrUrl);
        }

        if (typeof keyOrBytesOrUrl === 'string' && (/^https?:\/\//i.test(keyOrBytesOrUrl) || keyOrBytesOrUrl.endsWith('.brfs'))) {
            return resolveFilesystemSource(keyOrBytesOrUrl);
        }

        if (typeof indexedDB !== 'undefined' && typeof keyOrBytesOrUrl === 'string') {
            const data = await this._idbGet(keyOrBytesOrUrl);
            if (data && isBinaryContainer(data)) {
                return deserializeBinaryFilesystem(data);
            }
        }

        return null;
    }

    /**
     * Loads a saved filesystem snapshot from IndexedDB if one exists for `key`,
     * or falls back to loading `fallbackSource` (such as a `'/fs.brfs'` URL or initial object).
     * Can be passed directly to `new Shell({ filesystem: Shell.Storage.loadOrFetch('my-app', '/fs.brfs') })`.
     */
    static async loadOrFetch(key = 'brsh-rootfs', fallbackSource = {}) {
        const saved = await this.load(key);
        if (saved) {
            return saved;
        }
        return resolveFilesystemSource(fallbackSource);
    }

    /**
     * Creates an `onFsChange` callback that automatically persists the binary container
     * to IndexedDB (and optionally calls a user callback with `{ bytes, filesystem, permissions }`).
     */
    static createAutoSave(key = 'brsh-rootfs', onSaved = null) {
        return (rawFs, rawPerms) => {
            const bytes = serializeBinaryFilesystem(rawFs, rawPerms);
            if (typeof indexedDB !== 'undefined') {
                this._idbPut(key, bytes).catch(() => {});
            }
            if (typeof onSaved === 'function') {
                onSaved(bytes, rawFs, rawPerms);
            }
        };
    }

    static _openIdb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('brsh_fs_storage', 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore('snapshots');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    static async _idbPut(key, val) {
        const db = await this._openIdb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('snapshots', 'readwrite');
            tx.objectStore('snapshots').put(val, key);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    static async _idbGet(key) {
        const db = await this._openIdb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('snapshots', 'readonly');
            const req = tx.objectStore('snapshots').get(key);
            req.onsuccess = () => { db.close(); resolve(req.result || null); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }
}

module.exports = {
    MAGIC,
    FORMAT_VERSION,
    isBinaryContainer,
    isGzipBytes,
    isAsyncFilesystemSource,
    resolveFilesystemSource,
    serializeBinaryFilesystem,
    deserializeBinaryFilesystem,
    FilesystemStorage
};

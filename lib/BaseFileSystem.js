'use strict';

// The set of methods exposed to command instances via sandbox().
// Anything not in this list is inaccessible to user-supplied commands.
const SANDBOX_ALLOWED = new Set([
    'cwd',
    'getFileByPath', 'setFileByPath', 'deleteFileByPath',
    'exists', 'stat', 'absolutePath',
    'getMode', 'setMode',
    'isReadable', 'isWritable', 'isExecutable',
    'getSize', 'autoComplete',
    'isRealFilesystem', 'isSymlink', 'readSymlink', 'createSymlink',
    'setTtyDevice', 'loadModule',
]);

/**
 * Abstract base class for filesystem implementations.
 *
 * Subclasses must implement:
 *   getFileByPath(path)
 *   _getFileRaw(path)
 *   setFileByPath(path, content, createDir)
 *   deleteFileByPath(path)
 *   exists(path)
 *   stat(path)
 *   absolutePath(path)
 *   getMode(path)
 *   setMode(path, mode)
 *   getSize(path)
 *   autoComplete(initial, commandPath)
 *   setCwd(cwd)
 *   getRaw()
 *   getRawPermissions()
 *   addFiles(commands)
 */
class BaseFileSystem {
    /**
     * Loads and evaluates a JavaScript module from the filesystem at `path`,
     * returning its default or CommonJS export.
     * Subclasses (like NodeFileSystem) can override this to use native module loaders.
     */
    loadModule(path) {
        const content = this.getFileByPath(path);
        if (content === null || content === undefined) {
            throw new Error(`${path}: No such file or directory`);
        }
        if (typeof content === 'function') {
            return content;
        }
        let code = typeof content === 'string' ? content : new TextDecoder().decode(content);
        if (/^\s*export\s+default\s+/m.test(code)) {
            code = code.replace(/^\s*export\s+default\s+/m, 'module.exports = ');
        }

        const moduleObj = { exports: {} };
        const Command = require('./Command');
        const LocalCommand = require('./local/LocalCommand');
        const WasmCommand = require('./WasmCommand');
        const InteractiveCommand = require('./InteractiveCommand');
        const ReplCommand = require('./ReplCommand');
        const fn = new Function('module', 'exports', 'require', 'Command', 'LocalCommand', 'WasmCommand', 'InteractiveCommand', 'ReplCommand', code);
        fn(moduleObj, moduleObj.exports, require, Command, LocalCommand, WasmCommand, InteractiveCommand, ReplCommand);
        return moduleObj.exports.default !== undefined ? moduleObj.exports.default : moduleObj.exports;
    }

    isReadable(path) {
        const mode = this.getMode(path);
        if (mode === null) return false;
        return (mode & 0o400) !== 0;
    }

    isWritable(path) {
        const mode = this.getMode(path);
        if (mode === null) return false;
        return (mode & 0o200) !== 0;
    }

    isExecutable(path) {
        const mode = this.getMode(path);
        if (mode === null) return false;
        return (mode & 0o100) !== 0;
    }

    // Returns a sandboxed proxy of this filesystem for use by commands.
    // Only the public API is accessible; raw/internal methods are blocked.
    sandbox() {
        const target = this;
        return new Proxy(Object.create(null), {
            get(_, prop) {
                if (!SANDBOX_ALLOWED.has(prop)) return undefined;
                const val = target[prop];
                return typeof val === 'function' ? val.bind(target) : val;
            },
            set() { return false; },
            has(_, prop) { return SANDBOX_ALLOWED.has(prop); },
        });
    }

    // Schedules a single onChange notification per microtask tick,
    // so multiple mutations in one command emit only one callback.
    _triggerChange() {
        if (!this._onChange || this._changeScheduled) return;
        this._changeScheduled = true;
        Promise.resolve().then(() => {
            this._changeScheduled = false;
            if (typeof this._onChange === 'function') {
                this._onChange(this.getRaw(), this.getRawPermissions());
            }
        });
    }
}

/**
 * Represents a binary file stored as raw bytes in the virtual filesystem.
 * Extends Uint8Array so binary-aware commands can access bytes directly,
 * while text-based commands (cat, grep, etc.) get the original data URI
 * via toString() — avoiding the 33% base64 memory overhead at runtime.
 */
class BinaryFile extends Uint8Array {
    constructor(buffer, mimeType) {
        super(buffer);
        Object.defineProperty(this, 'mimeType', { value: mimeType, enumerable: false, configurable: false, writable: false });
    }

    toString() {
        if (typeof Buffer !== 'undefined') {
            return `data:${this.mimeType};base64,${Buffer.from(this).toString('base64')}`;
        }
        // Browser path — chunked to avoid stack overflow on large files
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < this.length; i += chunk) {
            binary += String.fromCharCode(...this.subarray(i, i + chunk));
        }
        return `data:${this.mimeType};base64,${btoa(binary)}`;
    }
}

/**
 * Represents a symbolic link stored in the virtual filesystem.
 * Acts as an opaque marker: `_resolveByAbsolutePath` follows these
 * transparently during file access, while lstat-like calls return the
 * SymlinkRef itself so callers can detect and report symlinks.
 */
class SymlinkRef {
    constructor(target) {
        this.target = target;
    }

    toJSON() {
        return { $l: this.target };
    }
}

/**
 * Represents a virtual character device node (e.g. /dev/null, /dev/zero, /dev/urandom, /dev/tty).
 */
class DeviceFile {
    constructor(name, options = {}) {
        this.name = name;
        this.read = typeof options.read === 'function' ? options.read : (() => '');
        this.write = typeof options.write === 'function' ? options.write : (() => {});
        this.mode = options.mode !== undefined ? options.mode : 0o666;
        this.isCharacterDevice = true;
    }

    toString() {
        const val = this.read();
        return val != null ? (typeof val === 'string' ? val : val.toString()) : '';
    }
}

const isUtf8Text = require('./isUtf8Text');

module.exports = BaseFileSystem;
module.exports.BinaryFile = BinaryFile;
module.exports.SymlinkRef = SymlinkRef;
module.exports.DeviceFile = DeviceFile;
module.exports.isUtf8Text = isUtf8Text;


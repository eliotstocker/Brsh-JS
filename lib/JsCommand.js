'use strict';

const WasmCommand = require('./WasmCommand');

/**
 * Handles loading, evaluating, and wrapping JavaScript commands and modules
 * stored on the brsh virtual or real filesystem.
 */
class JsCommand {
    static isCommandClass(fn) {
        return typeof fn === 'function'
            && Boolean(fn.prototype)
            && typeof fn.prototype.run === 'function'
            && typeof fn.prototype.runCommand === 'function';
    }

    static isJsFile(scriptPath, content) {
        if (typeof content === 'function') return true;
        if (scriptPath && scriptPath.endsWith('.js')) return true;
        return typeof content === 'string' && (content.includes('export') || content.includes('module.exports'));
    }

    /**
     * Loads a JavaScript module from the filesystem, evaluates it,
     * and returns an executable Command class.
     *
     * @param {Object} fs - The filesystem instance (BaseFileSystem / NodeFileSystem)
     * @param {string} scriptPath - Absolute path to the .js script
     * @param {string|Function|null} content - Optional pre-read content or function
     * @param {Map} [cache] - Optional cache Map to store evaluated classes by scriptPath
     * @returns {Function} Executable Command constructor
     */
    static load(fs, scriptPath, content = null, cache = null) {
        const fileContent = content !== null && content !== undefined
            ? content
            : (fs && typeof fs.getFileByPath === 'function' ? fs.getFileByPath(scriptPath) : null);

        if (cache && cache.has(scriptPath)) {
            const cached = cache.get(scriptPath);
            if (cached && cached.content === fileContent) {
                return cached.Cmd;
            }
        }

        if (typeof fileContent === 'function') {
            const Cmd = JsCommand.isCommandClass(fileContent)
                ? fileContent
                : JsCommand.wrapModule(fs, scriptPath, fileContent);
            if (cache) {
                cache.set(scriptPath, { content: fileContent, Cmd });
            }
            return Cmd;
        }

        let exported = null;
        try {
            if (fs && typeof fs.loadModule === 'function') {
                exported = fs.loadModule(scriptPath);
            } else {
                const nodeReq = typeof require !== 'undefined' ? require : null;
                if (nodeReq) {
                    exported = nodeReq(scriptPath);
                } else {
                    throw new Error('loadModule is not available on filesystem');
                }
            }
        } catch (e) {
            throw new Error(`${scriptPath}: Failed to evaluate script: ${e.message}`);
        }

        const Cmd = JsCommand.isCommandClass(exported)
            ? exported
            : JsCommand.wrapModule(fs, scriptPath, exported);

        if (cache) {
            cache.set(scriptPath, { content: fileContent, Cmd });
        }
        return Cmd;
    }

    /**
     * Wraps a non-Command export (e.g. exported function or module object)
     * as an executable GenericWasmCommand, automatically detecting any sibling .wasm binary.
     *
     * @param {Object} fs - The filesystem instance
     * @param {string} scriptPath - Absolute path to the .js file
     * @param {*} exported - The module's exported value
     * @returns {Function} Executable Command constructor
     */
    static wrapModule(fs, scriptPath, exported) {
        const binName = scriptPath.split('/').pop().replace(/\.js$/i, '').toLowerCase();
        const siblingWasmPath = scriptPath.replace(/\.js$/i, '.wasm');
        const hasSiblingWasm = fs && typeof fs.exists === 'function' && fs.exists(siblingWasmPath);
        const wasmBytes = (hasSiblingWasm && typeof fs.getFileByPath === 'function')
            ? fs.getFileByPath(siblingWasmPath)
            : null;

        const pkgMeta = {
            name: binName,
            bin: binName,
            wasmPath: hasSiblingWasm ? siblingWasmPath : null,
            wasmBytes: wasmBytes || null
        };

        const config = {
            moduleLoader: async () => exported
        };

        return WasmCommand.createGenericWasmCommand(pkgMeta, config, binName);
    }
}

module.exports = JsCommand;

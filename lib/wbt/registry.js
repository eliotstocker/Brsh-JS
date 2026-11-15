'use strict';

const rawRegistry = require('./registry.json');

/**
 * Default built-in fallback registry of WebAssembly packages for wbt (Web Binary Tool).
 *
 * The canonical source lives in `./registry.json` and is fetched/cached into
 * `/var/cache/wbt/registry.json` on first lookup or `wbt update`, falling back to
 * this bundled copy when offline or unavailable.
 */
const DEFAULT_REGISTRY = rawRegistry && rawRegistry.default ? rawRegistry.default : rawRegistry;

const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/eliotstocker/Brsh-JS/main/lib/wbt/registry.json';

function buildPackageAliases(registry) {
    const aliases = {};
    if (!registry || typeof registry !== 'object') return aliases;
    for (const [key, pkg] of Object.entries(registry)) {
        if (!pkg || typeof pkg !== 'object') continue;
        const canonical = pkg.name || key;
        if (pkg.bin && pkg.bin.toLowerCase() !== canonical.toLowerCase()) {
            aliases[pkg.bin.toLowerCase()] = canonical;
        }
        for (const list of [pkg.aliases, pkg.packageAliases]) {
            if (!Array.isArray(list)) continue;
            for (const alias of list) {
                if (typeof alias === 'string' && alias.trim()) {
                    const aliasLower = alias.toLowerCase();
                    if (aliasLower !== canonical.toLowerCase()) {
                        aliases[aliasLower] = canonical;
                    }
                }
            }
        }
    }
    return aliases;
}

const PACKAGE_ALIASES = buildPackageAliases(DEFAULT_REGISTRY);

function resolvePackageName(name, registry = null) {
    if (!name) return null;
    const lower = name.toLowerCase().replace(/^(npm|esm):/i, '').replace(/@[\d.^~><=*]+$/, '');

    if (registry && typeof registry === 'object') {
        if (registry[lower]) return lower;
        for (const pkg of Object.values(registry)) {
            if (!pkg || typeof pkg !== 'object') continue;
            if (pkg.name && pkg.name.toLowerCase() === lower) return pkg.name;
            if (pkg.bin && pkg.bin.toLowerCase() === lower) return pkg.name;
            if (Array.isArray(pkg.aliases) && pkg.aliases.some(a => typeof a === 'string' && a.toLowerCase() === lower)) {
                return pkg.name;
            }
            if (Array.isArray(pkg.packageAliases) && pkg.packageAliases.some(a => typeof a === 'string' && a.toLowerCase() === lower)) {
                return pkg.name;
            }
        }
    }

    return PACKAGE_ALIASES[lower] || lower;
}

module.exports = {
    DEFAULT_REGISTRY,
    DEFAULT_REGISTRY_URL,
    PACKAGE_ALIASES,
    resolvePackageName
};

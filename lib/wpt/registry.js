'use strict';

/**
 * Default built-in registry of WebAssembly packages for wpt (Web Package Tool).
 *
 * Each entry describes a package that can be installed via `wpt install <name>`:
 * - name: canonical package name
 * - bin: primary binary command name registered in PATH (defaults to name)
 * - aliases: optional extra command aliases (e.g. sqlite -> sqlite3, asrun/asnode -> assemblyscript)
 * - version: package version
 * - description: short summary shown in `wpt list` / `wpt search`
 * - details: extended description shown in `wpt show`
 * - homepage: upstream project URL
 * - cdnUrl: primary ESM CDN URL used to load the WASM package at runtime
 * - type: 'builtin-adapter' (uses a built-in Command adapter) | 'custom-wasm' (raw WASI binary)
 */
const DEFAULT_REGISTRY = {
    pglite: {
        name: 'pglite',
        bin: 'pglite',
        aliases: ['psql', 'pg_ctl'],
        version: '0.2.17',
        description: 'Lightweight WASM Postgres database & daemon in the browser and Node',
        details: 'PGlite is a WASM build of PostgreSQL packaged into a client-side library that runs a full Postgres database in memory, persisted to the brsh filesystem, or as a background server daemon (`pglite serve` / `pg_ctl start`).',
        homepage: 'https://pglite.dev',
        cdnUrl: 'https://esm.sh/@electric-sql/pglite@0.2.17',
        type: 'builtin-adapter',
        adapter: 'pglite',
        size: '3.1 MB'
    },
    sqlite3: {
        name: 'sqlite3',
        bin: 'sqlite3',
        aliases: ['sqlite'],
        version: '1.13.0',
        description: 'SQLite compiled to WebAssembly (via sql.js) with filesystem persistence',
        details: 'SQLite3 WASM allows creating, querying, and modifying SQLite database files directly in the brsh filesystem. Supports interactive SQL shell, piped SQL input, and one-shot queries.',
        homepage: 'https://sql.js.org',
        cdnUrl: 'https://esm.sh/sql.js@1.13.0',
        wasmUrl: 'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm',
        type: 'builtin-adapter',
        adapter: 'sqlite3',
        size: '680 KB'
    },
    assemblyscript: {
        name: 'assemblyscript',
        bin: 'asc',
        aliases: ['asrun', 'asnode', 'assemblyscript'],
        version: '0.27.31',
        description: 'AssemblyScript compiler (asc) and JIT/AOT runtime runner (asrun / asnode)',
        details: 'AssemblyScript compiles a strict variant of TypeScript to WebAssembly. Includes both `asc` (ahead-of-time compiler to .wasm/.wat) and `asrun` / `asnode` (ts-node style runner and interactive REPL that compiles and executes .ts files in memory with console.log/trace/abort host bindings).',
        homepage: 'https://www.assemblyscript.org',
        cdnUrl: 'https://esm.sh/assemblyscript@0.27.31/asc',
        type: 'builtin-adapter',
        adapter: 'asc',
        size: '1.4 MB'
    },
    jq: {
        name: 'jq',
        bin: 'jq',
        aliases: [],
        version: '1.7.1',
        description: 'Command-line JSON processor compiled to WebAssembly (jq-web)',
        details: 'jq is like sed for JSON data — you can use it to slice, filter, map, and transform structured JSON data from files or piped standard input.',
        homepage: 'https://jqlang.github.io/jq/',
        cdnUrl: 'https://esm.sh/jq-web@0.5.3',
        type: 'builtin-adapter',
        adapter: 'jq',
        size: '620 KB'
    },
    python3: {
        name: 'python3',
        bin: 'python3',
        aliases: ['python', 'py'],
        version: '3.12.1',
        description: 'CPython 3.12 compiled to WebAssembly (via Pyodide)',
        details: 'Full Python 3.12 runtime in WebAssembly powered by Pyodide. Supports interactive Python REPL (`>>>`), running `.py` scripts from the brsh filesystem, `-c` inline code evaluation, and piped standard input.',
        homepage: 'https://pyodide.org',
        cdnUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs',
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
        type: 'builtin-adapter',
        adapter: 'python3',
        size: '6.4 MB'
    },
    duckdb: {
        name: 'duckdb',
        bin: 'duckdb',
        aliases: [],
        version: '1.29.0',
        description: 'In-process analytical SQL OLAP database compiled to WebAssembly',
        details: 'DuckDB-WASM executes analytical SQL queries directly in WebAssembly, including querying CSV and JSON files stored in the brsh filesystem, interactive SQL shell, and one-shot / piped queries.',
        homepage: 'https://duckdb.org',
        cdnUrl: 'https://esm.sh/@duckdb/duckdb-wasm@1.29.0',
        type: 'builtin-adapter',
        adapter: 'duckdb',
        size: '4.2 MB'
    },
    graphviz: {
        name: 'graphviz',
        bin: 'dot',
        aliases: ['graphviz'],
        version: '1.13.0',
        description: 'Graphviz graph visualization compiler (`dot`) compiled to WebAssembly',
        details: 'Powered by @hpcc-js/wasm-graphviz. Compiles DOT language graph descriptions (`.dot` / `.gv`) into SVG, DOT, canon, or JSON formats (`dot -Tsvg input.dot -o output.svg`).',
        homepage: 'https://graphviz.org',
        cdnUrl: 'https://esm.sh/@hpcc-js/wasm-graphviz@1.13.0',
        type: 'builtin-adapter',
        adapter: 'graphviz',
        size: '1.1 MB'
    },
    ffmpeg: {
        name: 'ffmpeg',
        bin: 'ffmpeg',
        aliases: [],
        version: '0.12.10',
        description: 'FFmpeg multimedia framework compiled to WebAssembly (@ffmpeg/ffmpeg)',
        details: 'Record, convert, transcode, and inspect audio, video, and image files directly inside the brsh filesystem using WebAssembly (`ffmpeg -i input.mp4 output.webm`).',
        homepage: 'https://ffmpegwasm.netlify.app',
        cdnUrl: 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10',
        coreUrl: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
        type: 'builtin-adapter',
        adapter: 'ffmpeg',
        size: '8.5 MB'
    },
    wabt: {
        name: 'wabt',
        bin: 'wat2wasm',
        aliases: ['wasm2wat'],
        version: '1.0.36',
        description: 'WebAssembly Binary Toolkit (wat2wasm & wasm2wat)',
        details: 'WABT provides tools for translating between WebAssembly Text Format (.wat) and the WebAssembly binary format (.wasm), as well as inspecting WASM modules.',
        homepage: 'https://github.com/WebAssembly/wabt',
        cdnUrl: 'https://esm.sh/wabt@1.0.36',
        type: 'builtin-adapter',
        adapter: 'wabt',
        size: '540 KB'
    },
    quickjs: {
        name: 'quickjs',
        bin: 'qjs',
        aliases: ['quickjs'],
        version: '0.31.0',
        description: 'Sandboxed QuickJS JavaScript engine compiled to WebAssembly',
        details: 'QuickJS is a small and embeddable Javascript engine supporting ES2023. Runs JS code and files inside an isolated WebAssembly sandbox.',
        homepage: 'https://bellard.org/quickjs/',
        cdnUrl: 'https://esm.sh/quickjs-emscripten@0.31.0',
        type: 'builtin-adapter',
        adapter: 'quickjs',
        size: '820 KB'
    },
    lua: {
        name: 'lua',
        bin: 'lua',
        aliases: [],
        version: '5.4.6',
        description: 'Lua 5.4 interpreter compiled to WebAssembly (via wasmoon)',
        details: 'Full Lua 5.4 virtual machine compiled to WebAssembly. Supports interactive REPL, script execution from the brsh filesystem, and `-e` one-liners.',
        homepage: 'https://www.lua.org',
        cdnUrl: 'https://esm.sh/wasmoon@1.16.0',
        type: 'builtin-adapter',
        adapter: 'lua',
        size: '410 KB'
    }
};

// Map package aliases (e.g. `wpt install sqlite` -> `sqlite3`, `wpt install dot` -> `graphviz`)
const PACKAGE_ALIASES = {
    sqlite: 'sqlite3',
    'sqlite-wasm': 'sqlite3',
    psql: 'pglite',
    postgres: 'pglite',
    asc: 'assemblyscript',
    asrun: 'assemblyscript',
    asnode: 'assemblyscript',
    python: 'python3',
    py: 'python3',
    pyodide: 'python3',
    dot: 'graphviz',
    wat2wasm: 'wabt',
    wasm2wat: 'wabt',
    qjs: 'quickjs'
};

function resolvePackageName(name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    return PACKAGE_ALIASES[lower] || lower;
}

module.exports = {
    DEFAULT_REGISTRY,
    PACKAGE_ALIASES,
    resolvePackageName
};

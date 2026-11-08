'use strict';

/**
 * Default built-in registry of WebAssembly packages for wbt (Web Binary Tool).
 *
 * Each entry describes a package that can be installed via `wbt install <name>`:
 * - name: canonical package name
 * - bin: primary binary command name registered in PATH (defaults to name)
 * - aliases: optional extra command aliases (e.g. sqlite -> sqlite3, asrun/asnode -> assemblyscript)
 * - version: package version
 * - description: short summary shown in `wbt list` / `wbt search`
 * - details: extended description shown in `wbt show`
 * - homepage: upstream project URL
 * - cdnUrl: primary ESM CDN URL used to load the WASM package at runtime
 * - type: 'builtin-adapter' (uses a built-in Command adapter) | 'custom-wasm' (raw WASI binary)
 */
const DEFAULT_REGISTRY = {
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
        type: 'generic-runtime',
        repl: { prompt: 'sqlite> ', sessionArg: true },
        size: '680 KB'
    },
    assemblyscript: {
        name: 'assemblyscript',
        bin: 'asc',
        aliases: ['asrun', 'asnode', 'assemblyscript'],
        version: '0.27.31',
        description: 'AssemblyScript compiler (asc) and JIT/AOT runtime runner (asrun / asnode)',
        details: 'AssemblyScript compiles a strict variant of TypeScript to WebAssembly. Includes `asc` (ahead-of-time compiler to .wasm/.wat) and `asrun` / `asnode`.',
        homepage: 'https://www.assemblyscript.org',
        cdnUrl: 'https://esm.sh/assemblyscript@0.27.31/asc',
        wasmUrl: 'https://cdn.jsdelivr.net/npm/binaryen@119.0.0/index.wasm',
        type: 'generic-runtime',
        repl: { prompt: 'as> ', evalFlag: '-e' },
        size: '1.4 MB'
    },
    jq: {
        name: 'jq',
        bin: 'jq',
        aliases: [],
        version: '0.6.2',
        description: 'Command-line JSON processor compiled to WebAssembly (jq-web)',
        details: 'jq is like sed for JSON data — you can use it to slice, filter, map, and transform structured JSON data from files or piped standard input.',
        homepage: 'https://jqlang.github.io/jq/',
        cdnUrl: 'https://esm.sh/jq-web@0.6.2',
        wasmUrl: 'https://cdn.jsdelivr.net/npm/jq-web@0.6.2/jq.wasm',
        type: 'generic-runtime',
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
        wasmUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm',
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
        type: 'generic-runtime',
        repl: { prompt: '>>> ', evalFlag: '-c' },
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
        wasmUrl: 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/dist/duckdb-mvp.wasm',
        type: 'generic-runtime',
        repl: { prompt: 'D ', continuePrompt: '  > ', evalFlag: '-c' },
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
        wasmUrl: 'https://cdn.jsdelivr.net/npm/@hpcc-js/wasm-graphviz@1.13.0/dist/graphvizlib.wasm',
        type: 'generic-runtime',
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
        wasmUrl: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
        type: 'generic-runtime',
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
        wasmUrl: 'https://cdn.jsdelivr.net/npm/wabt@1.0.36/libwabt.wasm',
        type: 'generic-runtime',
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
        wasmUrl: 'https://cdn.jsdelivr.net/npm/@jitl/quickjs-wasmfile-release-sync@0.31.0/dist/emscripten-module.wasm',
        type: 'generic-runtime',
        repl: { prompt: 'qjs > ', evalFlag: '-e' },
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
        wasmUrl: 'https://cdn.jsdelivr.net/npm/wasmoon@1.16.0/dist/glue.wasm',
        type: 'generic-runtime',
        repl: { prompt: 'lua> ', evalFlag: '-e' },
        size: '410 KB'
    },
    wllama: {
        name: 'wllama',
        bin: 'wllama',
        aliases: ['llama', 'llama-cli'],
        version: '3.8.1',
        description: 'WebAssembly & WebGPU LLM inference engine powered by llama.cpp (@wllama/wllama)',
        details: 'Wllama v3 runs GGUF large language models in WebAssembly with automatic WebGPU hardware acceleration. Supports one-shot chat/text completions, interactive chat REPL, model inspection, embeddings, benchmarks, and Hugging Face & local filesystem GGUF loading.',
        homepage: 'https://github.com/ngxson/wllama',
        cdnUrl: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/esm/index.js',
        wasmUrl: 'https://cdn.jsdelivr.net/npm/@wllama/wllama@3.8.1/src/wasm/wllama.wasm',
        type: 'builtin-adapter',
        adapter: 'wllama',
        size: '8.8 MB'
    }
};

// Map package aliases (e.g. `wbt install sqlite` -> `sqlite3`, `wbt install dot` -> `graphviz`)
const PACKAGE_ALIASES = {
    sqlite: 'sqlite3',
    'sqlite-wasm': 'sqlite3',
    asc: 'assemblyscript',
    asrun: 'assemblyscript',
    asnode: 'assemblyscript',
    python: 'python3',
    py: 'python3',
    pyodide: 'python3',
    dot: 'graphviz',
    wat2wasm: 'wabt',
    wasm2wat: 'wabt',
    qjs: 'quickjs',
    llama: 'wllama',
    'llama-cli': 'wllama',
    'llama.cpp': 'wllama',
    '@wllama/wllama': 'wllama'
};

function resolvePackageName(name) {
    if (!name) return null;
    const lower = name.toLowerCase().replace(/^(npm|esm):/i, '').replace(/@[\d.^~><=*]+$/, '');
    return PACKAGE_ALIASES[lower] || lower;
}

module.exports = {
    DEFAULT_REGISTRY,
    PACKAGE_ALIASES,
    resolvePackageName
};

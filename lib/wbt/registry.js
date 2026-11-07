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
        usage: 'sqlite3 [OPTIONS] [FILENAME [SQL]]',
        options: [
            '-table                Set output mode to ASCII table',
            '-csv                  Set output mode to CSV',
            '-json                 Set output mode to JSON',
            '-list                 Set output mode to pipe-separated list (default)',
            '-header / -noheader   Turn column headers on or off',
            '-cmd SQL              Run SQL command before reading stdin',
            '-init FILE            Read and execute SQL file'
        ],
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
        usage: 'asc [entryFile ...] [options]',
        options: [
            '-o, --outFile <file>  Specify the WebAssembly binary output file (.wasm)',
            '-t, --textFile <file> Specify the WebAssembly text output file (.wat)',
            '-O, --optimize        Optimize the compiled WebAssembly module',
            '--runtime <type>      Specify runtime (incremental, minimal, stub)',
            '-e, --eval <code>     Evaluate inline AssemblyScript expression (asrun / asnode)'
        ],
        homepage: 'https://www.assemblyscript.org',
        cdnUrl: 'https://esm.sh/assemblyscript@0.27.31/asc',
        type: 'generic-runtime',
        repl: { prompt: 'as> ', evalFlag: '-e' },
        size: '1.4 MB'
    },
    jq: {
        name: 'jq',
        bin: 'jq',
        aliases: [],
        version: '1.7.1',
        description: 'Command-line JSON processor compiled to WebAssembly (jq-web)',
        details: 'jq is like sed for JSON data — you can use it to slice, filter, map, and transform structured JSON data from files or piped standard input.',
        usage: 'jq [options] <jq filter> [file...]',
        options: [
            '-r, --raw-output      Output raw strings, not JSON texts',
            '-c, --compact-output  Compact instead of pretty-printed output',
            '-n, --null-input      Use `null` as the single input value',
            '-s, --slurp           Read all inputs into an array and run filter once',
            '-S, --sort-keys       Sort keys of objects on output',
            '--arg <name> <val>    Set variable $name to string <val>'
        ],
        homepage: 'https://jqlang.github.io/jq/',
        cdnUrl: 'https://esm.sh/jq-web@0.5.3',
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
        usage: 'python3 [-c cmd | -m mod | file | -] [arg ...]',
        options: [
            '-c <cmd>              Program passed in as string (terminates option list)',
            '-m <mod>              Run library module as a script',
            '-i                    Inspect interactively after running script',
            '-u                    Force the stdout and stderr streams to be unbuffered',
            '-q                    Do not print version and copyright messages on interactive startup'
        ],
        homepage: 'https://pyodide.org',
        cdnUrl: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs',
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
        usage: 'duckdb [OPTIONS] [FILENAME] [SQL]',
        options: [
            '-c, -s <sql>          Run SQL query and exit',
            '-table / -box         ASCII table output mode (default)',
            '-csv                  CSV output mode',
            '-json                 JSON output mode',
            '-list                 Pipe-separated list output mode'
        ],
        homepage: 'https://duckdb.org',
        cdnUrl: 'https://esm.sh/@duckdb/duckdb-wasm@1.29.0',
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
        usage: 'dot [-Tformat] [-Klayout] [-o outfile] [infile ...]',
        options: [
            '-T<format>            Set output format (svg, dot, json, canon, plain)',
            '-K<layout>            Set layout engine (dot, neato, fdp, sfdp, twopi, circo)',
            '-o <outfile>          Write output to specified file path (default: stdout)'
        ],
        homepage: 'https://graphviz.org',
        cdnUrl: 'https://esm.sh/@hpcc-js/wasm-graphviz@1.13.0',
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
        usage: 'ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...',
        options: [
            '-i <infile>           Input file path in the brsh filesystem',
            '-f <fmt>              Force input or output file format',
            '-c, -codec <codec>    Select encoder or decoder (e.g. copy, libvpx, aac)',
            '-t <duration>         Record or transcode `duration` seconds of audio/video',
            '-y                    Overwrite output files without asking'
        ],
        homepage: 'https://ffmpegwasm.netlify.app',
        cdnUrl: 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10',
        coreUrl: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
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
        usage: 'wat2wasm [options] <infile.wat> [-o outfile.wasm]',
        options: [
            '-o, --output <file>   Output file path (.wasm for wat2wasm, .wat for wasm2wat)',
            '--debug-names         Write debug names to the generated binary',
            '--no-check            Don\'t check for invalid modules'
        ],
        homepage: 'https://github.com/WebAssembly/wabt',
        cdnUrl: 'https://esm.sh/wabt@1.0.36',
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
        usage: 'qjs [options] [file [args...]]',
        options: [
            '-e, --eval <expr>     Evaluate inline JavaScript expression',
            '-i, --interactive     Go to interactive mode after running file/expression',
            '-m, --module          Load as ES6 module (default=autodetect)',
            '--std                 Load the `std` and `os` modules'
        ],
        homepage: 'https://bellard.org/quickjs/',
        cdnUrl: 'https://esm.sh/quickjs-emscripten@0.31.0',
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
        usage: 'lua [options] [script [args...]]',
        options: [
            '-e <stat>             Execute string `stat`',
            '-i                    Enter interactive mode after executing `script`',
            '-l <name>             Require library `name` into global `name`',
            '-v                    Show version information'
        ],
        homepage: 'https://www.lua.org',
        cdnUrl: 'https://esm.sh/wasmoon@1.16.0',
        type: 'generic-runtime',
        repl: { prompt: 'lua> ', evalFlag: '-e' },
        size: '410 KB'
    }
};

// Map package aliases (e.g. `wbt install sqlite` -> `sqlite3`, `wbt install dot` -> `graphviz`)
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

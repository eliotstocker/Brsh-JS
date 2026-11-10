# CLI Utilities (`bin/`)

This directory contains the command-line utilities for building virtual filesystems and running `brsh` in Node.js.

---

## 1. `exportFileSystem`

`exportFileSystem` converts a local directory structure into a virtual filesystem bundle or `.brfs` binary container for use in `brsh`.

### How Files Are Imported

`exportFileSystem` traverses the directory structure from the provided root path and imports files according to the following rules:

* **JavaScript files (`.js`)**: Bundled via `esbuild` as CommonJS/ESM modules. Whatever they export is available directly to `brsh` — useful for adding custom `Command` classes (`module.exports = MyCommand`).
* **WebAssembly files (`.wasm`)**: Automatically wrapped as executable `WasmCommand` binaries (when placed in `/bin`) or stored as raw binary files.
* **Binary files (`.jpg`, `.png`, `.gif`, `.bmp`, `.webp`, `.ico`, `.pdf`, `.zip`, etc.)**: Stored as `BinaryFile` (`Uint8Array`) instances (or zero-overhead byte slices when using `--binary` / `.brfs`).
* **All other files**: Imported as UTF-8 strings, preserving Unix file permissions (`mode`) and symbolic links (`SymlinkRef`).

### CLI Options

| Option       | Alias | Type          | Description |
| ------       | ----- | ----          | ----------- |
| `root`       |       | `String` path | *(Default positional option, required)* Path to the root directory of your filesystem |
| `variable`   | `-v`  | `String` name | Global variable name (`globalThis.<variable>`) assigned when outputting a `.js` bundle (`{ filesystem, permissions }`). Not required when `-o` ends with `.brfs` |
| `output`     | `-o`  | `String` path | Output file path (`.js` bundle or standalone `.brfs` binary container) |
| `binary`     | `-b`  | `Boolean`     | Emit an indexed `BRFS` binary container (`.brfs`) with raw binary payloads, permissions, symlinks, and bundled JS commands instead of base64-in-JS |
| `compress`   | `-c`  | `Boolean`     | Gzip-compress the emitted `.brfs` container (or JS bundle) and generate a browser `DecompressionStream` loader when outputting `.js` |
| `pretty`     | `-p`  | `Boolean`     | Disable minification and pretty-print the JSON directory structure |
| `hyperlinks` | `-h`  | `Boolean`     | Set `process.env.FORCE_HYPERLINK="true"` in bundled JS commands so libraries emit ANSI OSC 8 hyperlinks |

### Examples

```shell
# Standard JS bundle (sets globalThis.fs = { filesystem, permissions })
exportFileSystem ./demo/filesystem -o ./demo/fs.js -v fs

# Standalone .brfs binary container (pass URL or Uint8Array directly to new Shell({ filesystem: '/fs.brfs' }))
exportFileSystem ./demo/filesystem -o ./demo/fs.brfs

# Binary .brfs container + tiny JS loader (sets globalThis.fs = Promise<{ filesystem, permissions }>)
exportFileSystem ./demo/filesystem -o ./demo/fs.js -v fs --binary --compress
```

### How It Works

`exportFileSystem` uses [`lib/buildFilesystemStructure.js`](../lib/buildFilesystemStructure.js) to walk the directory tree and record file contents, permissions, and symlinks, [`esbuild`](https://esbuild.github.io/) with `esbuild-plugin-polyfill-node` to bundle any `.js` command modules for the browser, and [`lib/BinaryContainer.js`](../lib/BinaryContainer.js) to serialize `.brfs` binary containers.

---

## 2. `wbt` (`bin/wbt.js`)

Standalone developer CLI to install WASM packages directly into a filesystem directory before packaging into a `.brfs` binary container with `exportFileSystem`.

### Pre-Installing Packages Prior to Container Export

```shell
# Pre-install packages into a local filesystem root
npx wbt --root ./demo/filesystem install nano wllama doom sqlite3

# Inspect installed packages in the root
npx wbt --root ./demo/filesystem list --installed

# Export the pre-installed filesystem into a standalone .brfs container
exportFileSystem ./demo/filesystem -o ./demo/fs.brfs
```

Packages are placed in `/usr/lib/<pkg>/` with symbolic links in `/bin/`. Because `brsh` resolves and executes commands, `.wasm` binaries, and `.js` modules directly from `/bin`, pre-packaged containers run out of the box in the browser without needing `wbt` or browser network calls.

### CLI Options

| Option                | Alias | Description |
| ------                | ----- | ----------- |
| `--root <dir>`        | `-r`  | Target filesystem directory (required for `install`, `remove`, `list`, `update`) |
| `--allow-system-root` |       | Explicit safety override to allow operating on host `/` |
| `--help`              | `-h`  | Show CLI help and available curated packages |
| `--version`           | `-v`  | Show `wbt` CLI version |

---

## 3. `brsh` (`bin/brsh-shell.js`)

Interactive Node.js REPL and non-interactive script/command runner backed by `brsh` (with `wbt` and `pico` pre-registered).

```shell
# Interactive REPL against the real Node.js filesystem
brsh

# Interactive REPL against the virtual demo filesystem
brsh --demo

# Run a single command string and exit
brsh -c "ls -la | grep Readme"

# Run a script file with arguments and shell flags (-e, -x)
brsh -e -x ./myscript.sh arg1 arg2
```

---

## 4. `bin/brsh-cmd.js`

Multi-call CLI wrapper used by the BusyBox compatibility test suite. Can be invoked directly (`node bin/brsh-cmd.js grep foo file.txt`) or symlinked under a command's name (`cat`, `cp`, `grep`, `ls`, `mv`, `rm`, `busybox`, etc.) to run any `brsh` command against the real Node.js filesystem.

---

## 5. `bin/zsh-server.js`

Zero-dependency HTTP + WebSocket server (`npm run demo:zsh`) that spawns a real OS shell (`$SHELL` / `/bin/zsh`) via [`lib/terminal/PtyBridge.js`](../lib/terminal/PtyBridge.js) and attaches it to `brsh/terminal` in the browser at `http://127.0.0.1:3080`.

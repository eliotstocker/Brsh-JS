# BRowserSHell (brsh)
[![npm version](https://badge.fury.io/js/brsh.svg)](https://badge.fury.io/js/brsh)

An extensible POSIX-like shell written in JavaScript with an accompanying VT100/ANSI terminal emulator.

[Demo](http://eliotstocker.github.io/Brsh-JS/)

## What is it?
A POSIX-like shell backend and VT100 terminal emulator that lets you embed a working terminal in a web app, connect to a real OS PTY / WebSocket stream, or run an interactive shell against the real filesystem in Node.js.

## Why?
No idea, you tell me

## Known Issues
* Input on Android is not working

# How?
To create a new terminal in the browser, include the stylesheet, `Shell`, and `Terminal` on your page:
```html
<link rel="stylesheet" href="//unpkg.com/brsh@3/dist/brsh.css">
<script src="//unpkg.com/brsh@3/dist/shell.min.js"></script>
<script src="//unpkg.com/brsh@3/dist/terminal.min.js"></script>
```

You may also use it as a Node module. Install via npm:
```shell
npm i brsh
```

Import both `Shell` and `Terminal` in your code:
```js
// ESM
import Shell from 'brsh';
import Terminal from 'brsh/terminal';

// CJS
const Shell = require('brsh');
const Terminal = require('brsh/terminal');
```

You may then instantiate the terminal like so:
```js
const term = new Terminal({
    el: document.body,
    profile: '/test/.profile',
    cwd: '/test',
    filesystem: { test: { '.profile': 'echo "hi there!"' } },
    cursor: 'blink',
    outputAnimation: 'type',
    animateSpeed: 2
});
```

### Terminal-Specific Options

All [Shell options](#shell-options) are also accepted and forwarded directly to the underlying `Shell` instance (unless `stream` is provided or `Shell: false` is set).

| Option          | Required | Default       | Description |
| ------          | -------- | -------       | ----------- |
| el              | Yes      |               | An `HTMLElement` to mount the terminal emulator into |
| cli / shell     | No       |               | An existing `Shell` instance to attach the terminal emulator to |
| Shell           | No       | `Shell`       | Custom `Shell` constructor to use, or `false`/`null` to run the terminal without a `Shell` instance |
| stream          | No       | `null`        | A Duplex stream or WebSocket to attach directly to the terminal (bypasses creating a `Shell`) |
| cols            | No       | `80`          | Initial terminal width in columns (automatically re-measured when mounted in the DOM) |
| rows            | No       | `24`          | Initial terminal height in rows (automatically re-measured when mounted in the DOM) |
| maxScrollback   | No       | `1000`        | Maximum number of scrollback lines retained in the primary screen buffer |
| font            | No       | `Roboto Mono` | Name of a Google Webfont to load for the console font; a monospace font is recommended |
| cursor          | No       | `none`        | One of: `none`, `block`, `blink`. If `block` or `blink`, a cursor block character is shown at the cursor position |
| outputAnimation | No       | `none`        | One of: `none`, `type`. If `type`, characters are appended per frame for a retro typing effect |
| animateSpeed    | No       | `1`           | Characters per tick (`1`–`20`) for the `type` animation. Higher is faster |
| onExit          | No       | `null`        | Callback invoked with `(code)` when the attached shell or PTY session exits |
| mobileInput     | No       | `click`       | One of `none` or `click`. Set to `click` to enable tap-to-focus (shows on-screen keyboard on mobile) |
| lineWrap        | No       | `false`       | When `true`, long lines wrap to the next line instead of overflowing |

### Terminal Public Methods

`Terminal` includes a full VT100/ANSI state machine (supporting 16/256/TrueColor SGR, alternate screen buffer `?1049h`, DEC line drawing, OSC 8 hyperlinks, bracketed paste `?2004h`, and X10/UTF-8/SGR mouse tracking):

| Method          | Arguments                         | Description |
| ------          | ---------                         | ----------- |
| write           | `String \| Uint8Array` data       | Write raw terminal output (including ANSI/VT100 escape sequences) to the screen |
| writeln         | `String` data                     | Write data followed by `\r\n` |
| clear           |                                   | Clear the screen and scrollback buffer |
| reset           |                                   | Reset the VT100 parser and screen buffer to initial state |
| resize          | `Number` cols, `Number` rows      | Resize the terminal grid and notify attached shell/streams |
| onData          | `Function` callback               | Subscribe to raw terminal input sequences (keystrokes, paste, mouse reports). Returns an unsubscribe function |
| onResize        | `Function` callback               | Subscribe to `{ cols, rows }` resize events. Returns an unsubscribe function |
| onTitleChange   | `Function` callback               | Subscribe to window title changes set via OSC `0` / `2`. Returns an unsubscribe function |
| attach          | `Stream \| WebSocket` stream      | Attach an external Duplex stream, `Shell`, or WebSocket. Returns a `detach()` function |
| spawn           | `String` cmd, `Array` args, `Object` opts | *(Node.js only)* Spawn a real OS PTY process (e.g. `'/bin/zsh'`) and attach it to the terminal. Returns `{ pty, detach }` |
| createTty       | `Object` options                  | Create a Node-compatible `{ stdin, stdout, dispose }` TTY stream pair (compatible with `blessed` and `readline`) |
| onCommand       | `String` command                  | Execute a command string in the attached shell (or send `command + '\r'` to an attached stream) |
| sendKey         | `String` key, `Object` modifiers  | Programmatically send a key press (e.g. `term.sendKey('ArrowLeft', { alt: true })`) |
| sendMouse       | `String` type, `Object` event     | Programmatically dispatch a mouse event (`mousedown`, `mouseup`, `mousemove`, `wheel`) at 1-based `{ col, row, button }` |
| getScreenText   | `Object` options                  | Return the current visible screen text (`{ trimRight: true }`) |
| getLineText     | `Number` row, `Boolean` trimRight | Return the text of a single 0-based screen row |

### Shell Options

| Option             | Required | Default     | Description |
| ------             | -------- | -------     | ----------- |
| path               | No       | `'/bin'`    | Path in which to look for (and register) built-in binaries |
| profile            | No       |             | A script to run before user interactivity (see [scripts](#writing-scripts)). If `/etc/profile` exists on the virtual filesystem, it is sourced first |
| motd               | No       |             | Optional path to a Message of the Day file/script/directory, or `false` to disable. By default, executable scripts in `/etc/update-motd.d/` and `/etc/motd` are displayed before `profile` on interactive login unless `.hushlogin` exists or an initial `command` is run |
| command            | No       | `null`      | An initial command string to run after `profile` loads (equivalent to `sh -c <cmd>`). Suppresses MOTD and sets `c` in `$-` during initialization |
| interactive        | No       | `true`      | Whether the shell is interactive (sets `i` in `$-`) |
| hostname           | No       | `'browser'` | Hostname shown in the prompt |
| filesystem         | No       | `{}`        | Virtual filesystem source: a JS object, `.brfs` URL string, `Uint8Array` / `ArrayBuffer`, or `Promise`. Classes extending `Command` are treated as executables. Use [exportFileSystem](bin/Readme.md) to generate this from a real directory |
| permissions        | No       | `{}`        | Map of virtual absolute paths to Unix mode bits (e.g. `{ '/bin/myscript.sh': 0o755 }`). Files without an entry default to `0o644`; function/class entries default to `0o555` |
| cwd                | No       | `'/'`       | Starting working directory |
| onFsChange         | No       | `null`      | Callback `(filesystem, permissions) => {}` fired whenever the virtual filesystem changes (e.g. after a write, chmod, or delete) |
| useRealFilesystem  | No       | `false`     | When `true`, uses the real Node.js filesystem instead of the virtual one. Intended for CLI use |

## Running an Interactive Shell in Node

`npm run shell` (or `npx brsh`) starts an interactive `brsh` session against the real filesystem, with tab completion and full-screen interactive app support:

```shell
npm run shell
# Or run the bundled virtual demo filesystem in Node:
npm run demo:shell
# Or start a browser-based real zsh PTY server on http://127.0.0.1:3080:
npm run demo:zsh
```

To use `Shell` programmatically without `Terminal`:

```js
const Shell = require('brsh');

const shell = new Shell({
    useRealFilesystem: true,
    cwd: process.cwd(),
    hostname: 'myapp'
});

// If loading an async filesystem (.brfs URL, Promise, or IndexedDB), await `shell.ready` or use `Shell.create()`:
await shell.ready;
```

## Shell Public Methods & Static Helpers

| Method / Property   | Arguments                     | Description |
| ------              | ---------                     | ----------- |
| `onCommand`         | `String` command, `Boolean` events | Run a command string in the shell, e.g. `ls -al ./root`. Returns a Promise |
| `sendCommand`       | `String` command              | Queue or run a command (automatically suppresses MOTD if called before boot completes) |
| `write`             | `String \| Uint8Array` data   | Feed raw terminal input bytes/keystrokes into the shell's built-in line editor or active interactive command |
| `resize` / `setTerminalSize` | `Number` cols, `Number` rows | Update `COLUMNS` and `LINES` and resize the shell's TTY streams |
| `tabCompletion`     | `String` partial              | Returns `{ path, options }` with completion candidates, or `null` if there are none |
| `getPrompt`         |                               | Returns the current hostname and cwd formatted as a prompt string |
| `suppressMotd`      |                               | Suppresses the startup MOTD banner and sets `c` in `$-` |
| `destroy`           | `Number` code (optional)      | Destroys the shell instance and emits `status` (`Shell.STATUS_DESTROYED`) and `exit` |
| `clear`             |                               | Clears the terminal output and emits the `clear` event |
| `shell.ready`       |                               | Promise that resolves to the `Shell` instance once any async filesystem source has mounted |
| `Shell.create`      | `Object` options              | Static async factory that pre-resolves async filesystems and returns an initialized `Shell` |
| `Shell.fromContainer` | `String \| Uint8Array` source, `Object` options | Static async helper to create a `Shell` directly from a `.brfs` container URL or byte array |

## Shell Events

| Event        | Arguments         | Description |
| ------       | ---------         | ----------- |
| `stdOut`     | `String` line     | A line of standard output to display to the user |
| `stdErr`     | `String` line     | A line of standard error to display to the user |
| `stdOutRaw`  | `String` chunk    | Raw unbuffered chunk written directly to `stdout` |
| `data`       | `String` chunk    | Combined TTY output stream (prompts, line editing, ANSI sequences, and command output) |
| `exitCode`   | `Number` code     | Exit code of the most recently completed command |
| `status`     | `String` status   | Shell status: `Shell.STATUS_READY`, `Shell.STATUS_WORKING`, or `Shell.STATUS_DESTROYED` |
| `interactive`|                   | Fired when a full-screen `InteractiveCommand` or `ReplCommand` takes over the terminal |
| `resize`     | `{ cols, rows }`  | Fired when the terminal dimensions change |
| `clear`      |                   | Fired when the terminal should clear the screen |
| `exit`       | `Number` code     | Fired when the shell is destroyed. `code` is the final exit code |

An example CLI implementation can be found in [bin/brsh-shell.js](bin/brsh-shell.js).

# Built-in and Local Commands

These are simplified versions of standard Unix commands.

**Built-ins** (installed into `PATH`, default `/bin`):
* `cat`
* `echo`
* `false`
* `grep`
* `ls`
* `printf`
* `test` / `[`
* `true`

**Local commands** (always available in shell context):
* `alias`
* `cd`
* `chmod`
* `clear`
* `cp`
* `curl`
* `.` (dot) / `source`
* `exit`
* `export`
* `jsfunction`
* `ln`
* `mkdir`
* `mv`
* `pwd`
* `read`
* `rm`
* `set`
* `stat`
* `touch`
* `which`

## Adding New Commands

Create a class that extends `Shell.Command` (or `Shell.InteractiveCommand` / `Shell.ReplCommand` for full-screen TUI and REPL apps):
```js
class MyCommand extends Shell.Command {
    static get name() { return 'mycommand'; }
    get name() { return 'mycommand'; }

    run() {
        this.stdOut = 'Hello!';
        return Promise.resolve();
    }
}

shell.context.setCommand(MyCommand);
```

For full documentation on `Command`, `InteractiveCommand`, `ReplCommand`, and `WasmCommand`, see the [lib docs](lib/Readme.md).

### Streaming Output

Commands can emit output in real time before they finish by calling `this.flush()` (or writing raw ANSI chunks to `this.stdout.write()`):

```js
class ProgressCommand extends Shell.Command {
    static get name() { return 'progress'; }
    get name() { return 'progress'; }

    run() {
        this.stdOut = 'Starting...';
        this.flush();                     // emits stdOut immediately
        return doWork().then(result => result);
    }
}
```

## Writing Scripts

Scripts must start with a supported shebang (`#!/bin/sh`, `#!/bin/brsh`, or legacy `#!/sh.js`):

```sh
#!/bin/sh
echo "Hello from a script"
```

Scripts support `if`/`elif`/`else`/`fi`, `for ... in ...; do ... done`, `while ...; do ... done`, `case ... in ... esac`, functions, pipes (`|`), logical operators (`&&`, `||`, `;`), output redirection (`>`, `>>`), command substitution `$(...)`, arithmetic `$((...))`, and `set -e` / `set -x`.

Scripts run in a sub-shell and do not share context with the parent. To persist context changes use `source` (or `.`).

**Note:** when using [exportFileSystem](bin/Readme.md), do not give shell scripts a `.js` extension — that causes them to be bundled as JavaScript modules rather than script strings.

## Web Binary Tool (`wbt`) — Optional WASM Binary Manager

`wbt` is an optional, APT-style binary manager for `brsh` that lets users install and run WebAssembly binaries (such as `nano`, `doom`, `wllama`, `sqlite3`, `assemblyscript` / `asc`, `jq`, `python3`, `duckdb`, `graphviz`, `ffmpeg`, `wabt`, `quickjs`, `lua`, or custom `.wasm`/`.wat`/ESM URLs). It is **not** included in the default shell bundle unless you explicitly register it.

### Enabling `wbt`

```js
// ESM
import Terminal from 'brsh/terminal';
import Wbt from 'brsh/wbt';

const term = new Terminal({ el: document.body });
term.cli.context.setCommand(Wbt);
```

```js
// CJS
const Shell = require('brsh');
const Wbt = require('brsh/wbt');

const shell = new Shell({ filesystem: {} });
shell.context.setCommand(Wbt);

// Optional: customize registry/sources or restore previously installed packages from a persisted FS
const CustomWbt = Wbt.configure({ registry: { /* custom packages */ } });
Wbt.restoreInstalled(shell);
```

### Loading WASM CLI Tools without `wbt` (Base Shell)

You can also register WASM CLI binaries directly into any `Shell` instance without `wbt`:

```js
import Shell from 'brsh';

// 1. From a WASM/ESM URL or bytes
const MyTool = Shell.createWasmCommand({
    name: 'mytool',
    wasmUrl: 'https://example.com/mytool.wasm'
});
shell.context.setCommand(MyTool);

// 2. Or place any raw .wasm / .wat binary into /bin in your virtual filesystem:
shell.onCommand('tool.wasm --help');
```

### Usage in the Shell

```sh
# List available or installed WASM packages
wbt list
wbt list --installed

# Search, inspect, and update package lists
wbt search sql
wbt show sqlite3
wbt update

# Install curated WASM packages into /bin
wbt install nano doom wllama sqlite3 assemblyscript jq python3 duckdb graphviz ffmpeg wabt quickjs lua

# Run a package directly without permanently installing it
wbt run jq -r ".name" package.json

# Run GNU nano text editor (compiled to WebAssembly with wide-char ncurses and built-in terminfo)
nano /home/hello.txt

# Run Classic Doom (compiled to WebAssembly with 24-bit ANSI rendering and Binaryen Asyncify)
curl -o doom1.wad https://raw.githubusercontent.com/wasm3/pywasm3-doom-demo/main/doom1.wad
doom -nosound

# Run Wllama v3 (llama.cpp WASM + WebGPU) for one-shot completions or interactive chat REPL!
wllama -p "Explain WebGPU in one sentence." # uses default SmolLM2 model (or pass -m qwen)
wllama pull smol -o /home/model.gguf
wllama -m /home/model.gguf # launches interactive multi-turn chat REPL

# Run SQLite3 (persists database files directly in the brsh filesystem, or run `sqlite3 /home/app.db` for interactive SQL REPL)
sqlite3 /home/app.db "CREATE TABLE notes (id INT, body TEXT); INSERT INTO notes VALUES (1, 'Hello WASM');"
sqlite3 -table /home/app.db "SELECT * FROM notes;"
echo "SELECT * FROM notes;" | sqlite3 -csv /home/app.db

# Run AssemblyScript directly like ts-node / node (`asrun` / `asnode`), or compile to .wasm (`asc`)
asrun -e "console.log('Hello from AssemblyScript!')"
asrun /home/script.ts
asc /home/hello.ts -o /home/hello.wasm && /home/hello.wasm

# Other built-in WASM tools (python3, duckdb, qjs, and lua also launch interactive REPLs when invoked with no arguments)
cat data.json | jq -r ".user.name"
python3 -c "print([x * x for x in range(5)])"
duckdb -c "SELECT 42 AS answer"
dot -Tsvg graph.dot -o graph.svg
ffmpeg -i input.mp4 output.webm
qjs -e "console.log(2 + 2)"
lua -e "print('Hello from Lua 5.4')"

# Install any generic Emscripten / WASI package or custom .wasm URL at runtime
wbt install npm:cowsay-wasm
wbt install mytool https://example.com/mytool.wasm
mytool

# Remove an installed binary
wbt remove sqlite3
```

## Compiling C / C++ Applications for `brsh`

`brsh` includes built-in runtime support for WebAssembly binaries targeting WASI Preview 1 (`wasm32-wasip1` / `wasm32-wasi`). Any standard C or C++ codebase can be compiled with `wasi-sdk` or Clang and executed directly inside the shell with full virtual filesystem access, environment variables, standard streams, and terminal features.

### Prerequisites & Toolchains

* **[wasi-sdk](https://github.com/WebAssembly/wasi-sdk)** (recommended): Complete Clang/LLVM toolchain with `wasi-libc`.
* **[Binaryen](https://github.com/WebAssembly/binaryen)** (`wasm-opt`): Required for instrumenting binaries with Asyncify for cooperative multitasking.
* **[wasi-termios-brsh](https://github.com/eliotstocker/wasi-termios-brsh)**: Drop-in POSIX `<termios.h>` and `<sys/ioctl.h>` compatibility library for interactive terminal applications and games.
* **[nano-wasm](https://github.com/eliotstocker/nano-wasm)**: Real-world reference repository demonstrating a complete C build setup (wasi-sdk, static ncurses 6.5, compiled-in terminfo fallbacks, and build scripts).

---

### 1. Compiling Standard CLI Utilities

For standard command-line tools that run to completion, read arguments, process files, and produce output:

```c
// hello.c
#include <stdio.h>

int main(int argc, char **argv) {
    const char *name = argc > 1 ? argv[1] : "world";
    printf("Hello, %s from WASI in brsh!\n", name);
    return 0;
}
```

Compile with `wasi-sdk`:

```bash
$WASI_SDK_PATH/bin/clang -O3 -o hello.wasm hello.c
```

Place `hello.wasm` into `/bin` in your `brsh` virtual filesystem or register it as a command:
```bash
hello.wasm Alice
# Hello, Alice from WASI in brsh!
```

---

### 2. Interactive Terminal Apps & Games (`termios` & Non-blocking I/O)

Many C terminal programs (such as text editors, roguelikes, games like Doom, or `ncurses` tools) rely on POSIX terminal controls:
* Entering raw / unbuffered mode (`tcgetattr`, `tcsetattr`, disabling `ICANON` and `ECHO`)
* Polling keyboard input without blocking (`c_cc[VMIN] = 0`, `c_cc[VTIME] = 0` or `O_NONBLOCK`)
* Querying terminal dimensions (`ioctl(STDIN_FILENO, TIOCGWINSZ, &ws)`)

Because `wasi-libc` omits `<termios.h>`, use [**`wasi-termios-brsh`**](https://github.com/eliotstocker/wasi-termios-brsh) as a drop-in header and implementation:

1. Clone or add `wasi-termios-brsh` to your project:
   ```bash
   git clone https://github.com/eliotstocker/wasi-termios-brsh.git
   ```

2. Include the headers and source file when compiling:
   ```bash
   $WASI_SDK_PATH/bin/clang -O3 -std=c99 \
     -I/path/to/wasi-termios-brsh/include \
     app.c /path/to/wasi-termios-brsh/src/termios.c \
     -o app.wasm
   ```

`wasi-termios-brsh` maps POSIX terminal operations directly to `brsh`'s WASI runtime:
* Setting `VMIN = 0` and `VTIME = 0` switches the descriptor flags to `FDFLAGS_NONBLOCK` via `fcntl()` / `fd_fdstat_set_flags`. In non-blocking mode, empty reads immediately return `EAGAIN` / `EWOULDBLOCK` instead of suspending execution.
* Calling `ioctl(..., TIOCGWINSZ, &ws)` reads `ws_col` and `ws_row` from the `$COLUMNS` and `$LINES` environment variables automatically exported by `brsh`.
* Interactive keyboard reads can target `stdin` (`fd 0`) or `stderr` (`fd 2`).

---

### 3. Cooperative Multitasking with Asyncify

In a browser, WebAssembly execution runs on the main JavaScript thread. If a game loop calls `nanosleep()` / `usleep()` or waits on a blocking `read()`, it would block the browser event loop, preventing DOM rendering and keyboard input dispatch.

`brsh` solves this using Binaryen's **Asyncify** in `WasmCommand`. To enable non-blocking timers and cooperative yielding, post-process your `.wasm` binary with `wasm-opt`:

```bash
wasm-opt -O3 --asyncify \
  --pass-arg=asyncify-imports@wasi_snapshot_preview1.poll_oneoff,wasi_snapshot_preview1.clock_nanosleep,wasi_snapshot_preview1.fd_read \
  app.wasm -o app-asyncify.wasm
```

When the WASM binary calls `poll_oneoff`, `clock_nanosleep`, or a blocking `fd_read`, `brsh` saves the execution state, yields control back to the browser's event loop, and resumes execution seamlessly when the timer fires or input arrives.

---

### 4. Running WebAssembly Binaries in `brsh`

There are three ways to execute your compiled `.wasm` binary:

#### A. Place into `/bin` in the Virtual Filesystem
Any `.wasm` binary placed in `/bin` or `/usr/bin` (via `exportFileSystem` or runtime `fs.setFileByPath`) is automatically executed as a command:
```bash
mytool.wasm arg1 arg2
```

#### B. Register via `Shell.createWasmCommand`
Create an explicit command wrapper with custom metadata and interactive TTY flags:
```js
import Shell from 'brsh';

const MyGame = Shell.createWasmCommand({
    name: 'mygame',
    wasmUrl: 'https://example.com/mygame.wasm',
    interactive: true // Enters alternate screen buffer (\x1b[?1049h) & raw keyboard mode
});

shell.context.setCommand(MyGame);
```

#### C. Install via `wbt` (Web Binary Tool)
If `wbt` is enabled in the shell:
```bash
wbt install mygame https://example.com/mygame.wasm
mygame
```

---

### Real-World Examples

* [**eliotstocker/nano-wasm**](https://github.com/eliotstocker/nano-wasm): GNU nano 8.0 text editor compiled to `wasm32-wasip1` with wide-character `ncurses 6.5` and built-in terminfo fallbacks.
* [**eliotstocker/doom-wasm**](https://github.com/eliotstocker/doom-wasm): Classic Doom (`doom-ascii` 0.3.2) compiled to `wasm32-wasip1` with Binaryen Asyncify and `wasi-termios-brsh`, streaming 24-bit RGB ANSI frames at ~70 FPS in `brsh`.


## Binary Filesystem Container (`.brfs`) & Client-Side Persistence

While `brsh` continues to support standard JS object filesystems (and compressed `.js` + `.brfs` loader bundles), it also supports an **Indexed Binary Container (`.brfs`)** format (`BRFS` magic header + JSON metadata/permissions index + contiguous raw binary payload with zero base64 overhead) as well as **IndexedDB client-side persistence**.

### Exporting a `.brfs` Binary Container

```shell
# Standalone .brfs binary container (load via URL or fetch('/fs.brfs').then(r => r.arrayBuffer()))
exportFileSystem ./filesystem -o ./fs.brfs

# Or generate a JS loader that fetches and mounts ./fs.brfs automatically
exportFileSystem ./filesystem -o ./fs.js -v fs --binary
```

### Mounting & Snapshot Serialization

```js
// Pass a .brfs URL directly to Terminal or Shell (no JS loader needed!):
const term = new Terminal({
    el: document.body,
    filesystem: '/fs.brfs'
});

// Or pass a pre-fetched ArrayBuffer / Uint8Array (raw or gzip-compressed):
const bytes = new Uint8Array(await (await fetch('/fs.brfs')).arrayBuffer());
const shell = new Shell({ filesystem: bytes });

// Export the live filesystem (including runtime changes, permissions, symlinks, and binaries) to a .brfs Uint8Array:
const snapshot = shell.context.fs.toBinaryContainer();
```

### Client-Side Persistence (IndexedDB)

Use `Shell.Storage` (`FilesystemStorage`) to persist user changes across page reloads in IndexedDB:

```js
const Terminal = require('brsh/terminal');
const Shell = require('brsh');

const term = new Terminal({
    el: document.body,
    // Loads saved snapshot from IndexedDB if present, otherwise fetches '/fs.brfs'
    filesystem: Shell.Storage.loadOrFetch('my-app', '/fs.brfs'),
    // Automatically persists binary container to IndexedDB whenever files or permissions change
    onFsChange: Shell.Storage.createAutoSave('my-app')
});

// Or manually save/load at any time:
await Shell.Storage.save(term.cli, 'my-app');
const savedFs = await Shell.Storage.load('my-app');
```

## More Examples
On my website I have extended the functionality adding some simple extra utilities such as an ANSI image viewer and a markdown parser based on open-source Node CLI utilities.

[See the site in action here](https://piratemedia.tv/)

[GitHub source code here](https://github.com/eliotstocker/piratemedia.tv)

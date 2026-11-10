# Writing Custom Commands (`lib/`)

`brsh` exposes four command base classes on the `Shell` constructor so you can write everything from simple one-shot utilities to full-screen interactive TUI applications and WebAssembly tools:

* `Shell.Command` — Standard CLI command (output lines, exit codes, streaming output, piped stdin, optional filesystem access)
* `Shell.InteractiveCommand` — Full-screen interactive TUI application (alternate screen buffer `?1049h`, raw key input, terminal dimensions)
* `Shell.ReplCommand` — Hybrid CLI + interactive full-screen REPL command
* `Shell.WasmCommand` / `Shell.createWasmCommand` — WASI / Emscripten / ESM WebAssembly command wrapper

---

## 1. Standard Commands (`Shell.Command`)

Extend `Shell.Command` and register your class via `shell.context.setCommand(MyCommand)` (or place it in `/bin` inside your virtual filesystem):

```js
const Shell = require('brsh');

class GreetCommand extends Shell.Command {
    static get name() { return 'greet'; }
    get name() { return 'greet'; }

    // Set to true if the command needs access to `this.fs` (sandboxed filesystem)
    get requiresFilesystem() { return false; }

    async run() {
        const target = this.arguments[0] || 'world';
        this.stdOut = `Hello, ${target}!`;
        this.exitCode = 0;
    }
}

shell.context.setCommand(GreetCommand);
```

### Properties & Methods on `Command`

| Property / Method | Description |
| --- | --- |
| `this.arguments` | `Array<String>` of parsed command-line arguments |
| `this.context` | Read-only shell context (`getVar(name)`, `getAlias(name)`, `getCommand(name)`) |
| `this.fs` | Sandboxed filesystem instance (only populated when `get requiresFilesystem() { return true; }`) |
| `this.stdin` | Piped input string when invoked in a pipeline (`cmd1 \| mycmd`), or `this.stdinStream` (`TtyStream`) |
| `this.stdout` / `this.stderr` | `TtyStream` instances (`columns`, `rows`, `write(chunk)`) |
| `this.stdOut = line` | Appends a line to standard output |
| `this.stdErr = line` | Appends a line to standard error |
| `this.exitCode = code` | Sets the numeric exit code (defaults to `0`, or `127` on unhandled rejection) |
| `this.flush()` | Immediately flushes any queued `stdOut` / `stdErr` lines to the shell before `run()` finishes (also supports `\r` in-place progress lines) |
| `this.captureInput` | Return `true` to receive live user keystrokes via `onInput(key)` while the command is running (e.g. `read`) |

### Sandboxed Filesystem API (`this.fs`)

When `get requiresFilesystem() { return true; }` is set on a command, `this.fs` provides:
* `getFileByPath(path)` / `setFileByPath(path, content, createDir)` / `deleteFileByPath(path)`
* `exists(path)` / `stat(path)` / `getSize(path)` / `absolutePath(path)`
* `getMode(path)` / `setMode(path, mode)` / `isReadable(path)` / `isWritable(path)` / `isExecutable(path)`
* `isSymlink(path)` / `readSymlink(path)` / `createSymlink(target, linkPath)`

---

## 2. Full-Screen Interactive Apps (`Shell.InteractiveCommand`)

Extend `Shell.InteractiveCommand` for full-screen terminal applications (like `pico`). `InteractiveCommand` automatically switches the terminal into the alternate screen buffer (`\x1b[?1049h`) and raw input mode on start, and restores the primary screen on exit.

```js
class MyEditor extends Shell.InteractiveCommand {
    static get name() { return 'myeditor'; }
    get name() { return 'myeditor'; }
    get requiresFilesystem() { return true; }

    run() {
        return new Promise((resolve) => {
            this._exit = resolve;
            this.render();
        });
    }

    onInput(key) {
        if (key === '^X' || key === 'Escape') {
            this._exit();
            return;
        }
        this.render(key);
    }

    render(lastKey = '') {
        const { cols, rows } = this.terminalSize;
        this.stdOut = `\x1b[2J\x1b[HLast key: ${lastKey} (${cols}x${rows})\nPress Ctrl+X to exit.`;
        this.flush();
    }
}
```

`onInput(key)` receives:
* Printable characters: `'a'`, `'B'`, `'1'`, `' '`, etc.
* Named navigation keys: `'ArrowUp'`, `'ArrowDown'`, `'ArrowLeft'`, `'ArrowRight'`, `'Enter'`, `'Backspace'`, `'Delete'`, `'Escape'`, `'Home'`, `'End'`, `'PageUp'`, `'PageDown'`, `'Tab'`
* Control combinations: `'^A'` through `'^Z'`

See [demo/pico.js](../demo/pico.js) for a complete implementation.

---

## 3. Interactive REPL Commands (`Shell.ReplCommand`)

Extend `Shell.ReplCommand` when a command supports both non-interactive CLI invocations (`runNonInteractive()`) and a full-screen interactive REPL with history, scrolling, and multi-line input (either by overriding `shouldBeInteractive()` / `initRepl()` / `evaluateReplLine(line)` or by calling `this.startRepl(opts)` dynamically).

---

## 4. WebAssembly Commands (`Shell.createWasmCommand`)

Wrap any WASI `.wasm` binary or ESM/Emscripten module into a `brsh` command:

```js
const MyWasmTool = Shell.createWasmCommand({
    name: 'mytool',
    wasmUrl: 'https://example.com/mytool.wasm',
    interactive: true // Set to true for full-screen TUIs / games (enables alternate screen buffer & raw TTY input)
});

shell.context.setCommand(MyWasmTool);
```

### Options for `Shell.createWasmCommand`

| Option | Type | Description |
| --- | --- | --- |
| `name` | `String` | Command name invoked in the shell |
| `wasmUrl` | `String` | URL to fetch the `.wasm` binary from |
| `wasmPath` | `String` | Optional path to `.wasm` binary stored in the virtual filesystem (`this.fs`) |
| `interactive` | `Boolean` | When `true`, automatically enters the alternate screen buffer (`\x1b[?1049h`) and routes live raw keyboard events to `stdin` (`fd 0`) and `stderr` (`fd 2`) |
| `bin` | `String` | Optional binary name override |
| `type` | `String` | `'wasm'` / `'custom-wasm'` for raw WASI, or omit for generic ESM/Emscripten |

### Compiling C / C++ Applications for `brsh`

`brsh` supports WASI Preview 1 binaries with non-blocking I/O (`FDFLAGS_NONBLOCK`), cooperative sleep/timers via Asyncify (`poll_oneoff`, `clock_nanosleep`), and terminal dimension queries.

* For POSIX terminal raw mode, baud rates, and `TIOCGWINSZ`, use [**`wasi-termios-brsh`**](https://github.com/eliotstocker/wasi-termios-brsh).
* For a complete real-world reference implementation of an interactive C TUI editor with ncurses targeting `brsh`, inspect [**`nano-wasm`**](https://github.com/eliotstocker/nano-wasm).
* For an interactive game loop with non-blocking event loops, clock sleeps, and 24-bit ANSI streaming, inspect [**`doom-wasm`**](https://github.com/eliotstocker/doom-wasm).
* For complete step-by-step instructions on compiling with `wasi-sdk`, configuring `termios`, and instrumenting with `wasm-opt --asyncify`, see [Compiling C / C++ Applications in the main Readme](../Readme.md#compiling-c--c-applications-for-brsh).



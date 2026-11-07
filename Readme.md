# BRowserSHell (brsh)
[![npm version](https://badge.fury.io/js/brsh.svg)](https://badge.fury.io/js/brsh)

An extensible POSIX Like shell written in Javascript with an accompanying terminal emulator

[Demo](http://eliotstocker.github.io/Brsh-JS/)

## What is it?
A POSIX Like Shell backend and Terminal Emulator that lets you embed a working terminal in a webapp, or run an interactive shell against the real filesystem in Node.

## Why?
No idea, you tell me

## Known Issues
* Input on android is not working

# How?
To create a new terminal first add both Terminal and Shell to your page:
```html
<script src="//unpkg.com/brsh@2/dist/shell.min.js"></script>
<script src="//unpkg.com/brsh@2/dist/terminal.min.js"></script>
```

You may also use it as a node module. Install via npm:
```shell
npm i brsh
```

Import the terminal in your code:
```js
// ESM
import Terminal from 'brsh/terminal';
// CJS
const Terminal = require('brsh/terminal');
```

You may then implement the terminal like so:
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

The Terminal constructor options extend those of the Shell:

### Terminal Specific options

All [Shell options](#shell-options) are also accepted and forwarded directly to the Shell instance.

| option          | required | default       | description |
| ------          | -------- | -------       | ----------- |
| el              | Yes      |               | A HTMLElement to fill with the terminal emulator |
| font            | No       | `Roboto Mono` | Name of a Google Webfont to use for the console font; a monospace font is recommended |
| cursor          | No       | `none`        | One of: `none`, `block`, `blink`. If `block` or `blink`, a cursor block character is shown at the end of the current line |
| outputAnimation | No       | `none`        | One of: `none`, `type`. If `type`, each character is appended in order for a retro typing effect |
| animateSpeed    | No       | `1`           | Characters per browser frame for the `type` animation. Higher is faster |
| onExit          | No       | `null`        | Function called when the shell session is destroyed. Without this, typing `exit` will leave the terminal in an ended state |
| mobileInput     | No       | `click`       | One of `none` or `click`. Set to `click` to enable tap-to-focus (and show the on-screen keyboard on mobile) |
| lineWrap        | No       | `false`       | When `true`, long lines wrap to the next line instead of overflowing |

### Shell options
| option             | required | default     | description |
| ------             | -------- | -------     | ----------- |
| path               | No       | `'/bin'`    | Path in which to look for (and register) built-in binaries |
| profile            | No       |             | A script to run before user interactivity (see [scripts](#writing-scripts)). If `/etc/profile` exists on the virtual filesystem, it is sourced first |
| motd               | No       |             | Optional path to a Message of the Day file/script/directory, or `false` to disable. By default, executable scripts in `/etc/update-motd.d/` and `/etc/motd` are displayed before `profile` on interactive login unless `.hushlogin` exists or an initial `command` is run |
| command            | No       | `null`      | An initial command string to run after `profile` loads (equivalent to `sh -c <cmd>` / `ssh host <cmd>`). Suppresses MOTD and sets `c` in `$-` during initialization |
| hostname           | No       | `'browser'` | Hostname shown in the prompt |
| filesystem         | No       | `{}`        | Object representing the virtual file system. Classes extending `Command` are treated as executables. Use [exportFileSystem](bin/Readme.md) to generate this from a real directory |
| permissions        | No       | `{}`        | Map of virtual absolute paths to Unix mode bits (e.g. `{ '/bin/myscript.sh': 0o755 }`). Files without an entry default to `0o644`; function/class entries default to `0o755` |
| cwd                | No       | `'/'`       | Starting working directory |
| onFsChange         | No       | `null`      | Callback fired whenever the virtual filesystem changes (e.g. after a write or delete). Useful for persisting filesystem state |
| useRealFilesystem  | No       | `false`     | When `true`, uses the real Node.js filesystem instead of the virtual one. Intended for CLI use |

## Running an interactive shell in Node

`npm run shell` starts an interactive brsh session against the real filesystem, with tab completion:

```shell
npm run shell
```

To use it programmatically:

```js
const Shell = require('brsh');

const shell = new Shell({
    useRealFilesystem: true,
    cwd: process.cwd(),
    hostname: 'myapp'
});
```

## Shell Public Methods
| Method        | Arguments                     | Description |
| ------        | ---------                     | ----------- |
| onCommand     | `String` command              | Run a command string in the shell, e.g. `ls -al ./root`. Returns a Promise |
| tabCompletion | `String` partial              | Returns `{ path, options }` with completion candidates, or `null` if there are none |
| getPrompt     |                               | Returns the current hostname and cwd formatted as a prompt string |
| destroy       | `Number` code (optional)      | Destroys the shell instance and emits the `exit` event |
| clear         |                               | Emits the `clear` event |

## Shell Events
| Event    | Arguments       | Description |
| ------   | ---------       | ----------- |
| stdOut   | `String` line   | A line of standard output to display to the user |
| stdErr   | `String` line   | A line of standard error to display to the user |
| exitCode | `Number` code   | Exit code of the most recently completed command |
| status   | `String` status | Shell status. `Shell.STATUS_READY` means a new command can be accepted; `Shell.STATUS_WORKING` means a command is running |
| clear    |                 | Fired when the terminal should clear the screen |
| exit     | `Number` code   | Fired when the shell is destroyed. `code` is the final exit code |

An example CLI implementation can be found in [bin/brsh-shell.js](bin/brsh-shell.js).

# Built-in and Local commands

These are simplified versions of standard Unix commands.

**Built-ins** (always available, no filesystem lookup):
* `cat`
* `echo`
* `false`
* `grep`
* `ls`
* `printf`
* `test` / `[`
* `true`

**Local commands**:
* `alias`
* `cd`
* `chmod`
* `clear`
* `cp`
* `curl`
* `. (dot)` / `source`
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

## Adding new commands

Create a class that extends `Command`. You can access it via `Shell.Command`:
```js
class MyCommand extends Shell.Command {
    get name() { return 'mycommand'; }

    run() {
        this.stdOut = 'Hello!';
        return Promise.resolve();
    }
}
```

Or import `Command` directly:
```js
// ESM
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Command = require('brsh/lib/Command');
```

For more on writing commands see the [lib docs](lib/Readme.md).

### Streaming output

Commands can emit output in real time before they finish by calling `this.flush()`:

```js
class ProgressCommand extends Shell.Command {
    get name() { return 'progress'; }

    run() {
        this.stdOut = 'Starting...';
        this.flush();                     // emits stdOut immediately
        return doWork().then(result => result);
    }
}
```

## Writing Scripts

Scripts must start with the shebang `#!/sh.js`:

```sh
#!/sh.js
echo "Hello from a script"
```

Scripts run in a sub-shell and do not share context with the parent. To persist context changes use `source`.

**Note:** when using [exportFileSystem](bin/Readme.md), do not give scripts a `.js` extension — that causes them to be loaded as JavaScript modules rather than script strings.

## Web Package Tool (`wpt`) — Optional WASM Package Manager

`wpt` is an optional, APT-style package manager for `brsh` that lets users install and run WebAssembly packages (such as `pglite`, `sqlite3`, `assemblyscript` / `asc`, `wabt`, `quickjs`, `lua`, or custom `.wasm`/`.wat` URLs). It is **not** included in the default shell bundle unless you explicitly register it.

### Enabling `wpt`

```js
// ESM
import Terminal from 'brsh/terminal';
import Wpt from 'brsh/wpt';

const term = new Terminal({ el: document.body });
term.cli.context.setCommand(Wpt);
```

```js
// CJS
const Shell = require('brsh');
const Wpt = require('brsh/wpt');

const shell = new Shell({ filesystem: {} });
shell.context.setCommand(Wpt);
```

### Usage in the shell

```sh
# List available or installed WASM packages
wpt list
wpt list --installed

# Search and inspect packages
wpt search postgres
wpt show pglite

# Install curated WASM packages into /bin
wpt install pglite sqlite3 assemblyscript jq python3 duckdb graphviz ffmpeg

# Run PGlite as a one-shot query, interactive REPL, or a background server daemon!
pglite -d /home/pgdata -c "CREATE TABLE users (id INT, name TEXT); INSERT INTO users VALUES (1, 'Ada');"
pglite # launches interactive PostgreSQL REPL

# Start a PGlite background daemon on localhost:5432 and query it via HTTP (curl / fetch) or psql
pg_ctl start -D /home/pgdata -p 5432
wpt services
curl -s -X POST -d "SELECT * FROM users;" http://localhost:5432/query
psql -p 5432 -c "SELECT * FROM users;"
pg_ctl stop -p 5432

# Run SQLite3 (persists database files directly in the brsh filesystem)
sqlite3 /home/app.db "CREATE TABLE notes (id INT, body TEXT); INSERT INTO notes VALUES (1, 'Hello WASM');"
sqlite3 -table /home/app.db "SELECT * FROM notes;"
echo "SELECT * FROM notes;" | sqlite3 -csv /home/app.db

# Run AssemblyScript directly like ts-node / node (`asrun` / `asnode`), or compile to .wasm (`asc`)
asrun -e "console.log('Hello from AssemblyScript!')"
asrun /home/script.ts
asc /home/hello.ts -o /home/hello.wasm && /home/hello.wasm

# Other built-in WASM tools: jq, python3 (Pyodide), duckdb, dot (Graphviz), ffmpeg
cat data.json | jq -r ".user.name"
python3 -c "print([x * x for x in range(5)])"
duckdb -c "SELECT 42 AS answer"
dot -Tsvg graph.dot -o graph.svg
ffmpeg -i input.mp4 output.webm

# Install any generic Emscripten / WASI package or custom .wasm URL at runtime (no custom wrapper needed!)
wpt install npm:cowsay-wasm
wpt install mytool https://example.com/mytool.wasm
mytool

# Remove an installed package
wpt remove sqlite3
```

## Binary Filesystem Container (`.brfs`) & Client-Side Persistence

While `brsh` continues to support standard JS object filesystems (and legacy `.brsh` compressed JS bundles), it also supports an **Indexed Binary Container (`.brfs`)** format (`BRFS` magic header + JSON metadata/permissions index + contiguous raw binary payload with zero base64 overhead) as well as **IndexedDB client-side persistence**.

### Exporting a `.brfs` Binary Container

```shell
# Standalone .brfs binary container (load via fetch('/fs.brfs').then(r => r.arrayBuffer()))
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
On my website I have extended the functionality adding some simple extra utilities such as an ANSI image viewer and a markdown parser based on open-source node CLI utilities.

[See the site in action here](https://piratemedia.tv/)

[GitHub source code here](https://github.com/eliotstocker/piratemedia.tv)


# How?
To create a new terminal first add both Terminal and Shell to your page like so:
```html
<script src="//unpkg.com/brsh@1/dist/shell.min.js"></script>
<script src="//unpkg.com/brsh@1/dist/terminal.min.js"></script>
```

You man also use terminal as a node module if you are bundling your code with something like browserify etc
Install the module via NPM:
```shell script
npm i brsh
```

require the module in your code:
```js
const Terminal = require('brsh/lib/Terminal');
```

you may then implement the terminal like so:
```js
const term = new Terminal({
    el: document.body,
    profile: '/test/.profile',
    cwd: '/test',
    filesystem: {"test": {".profile": "echo \"hi there!\""}},
    cursor: 'blink',
    outputAnimation: 'type',
    animateSpeed: 2
});
```

The Terminal constructor Options extend those of the Shell:

### Terminal Specific options
| option          | required | default       | description |
| ------          | -------- | -------       | ----------- |
| el              | Yes      |               | a HTMLElement to fill with the terminal emulator |
| font            | No       | `Roboto Mono` | the name of a google webfont to load for the emulators console font, a monospace font is recommended |
| cursor          | No       | `none`        | One of: `none`, `block`, `bink` if block or blink a cursor block character will show at the end of the current line, if bink this will animate with a simple blink |
| outputAnimation | No       | `none`        | Out of: `none`, `type` if type is set each character will be appended in order as to animate a more retro style of console output |
| animateSpeed    | No       | `1`           | number of frames to append per browser frame, the higher this number the faster the animation, i would recommend setting this higher than the default value of 1 |
| onExit          | No       | `null`        | function to run should the Shell session be destroyed, whist no required, if this is not set and the user types exit, the terminal will then hang in an ended state |
| mobileInput     | No       | `click`       | One of `none` or `click`, set to click to enable focus on the terminal (and show the onscreen keyboard on mobile |

### Shell options
| option          | required | default       | description |
| ------          | -------- | -------       | ----------- |
| path            | No       | '/bin'        | path in which to look for (and add default entries) binaries |
| profile          | No       |               | a script to run before user interactivity (see [scripts](#writing-scripts)) |
| hostname        | No       | 'browser'     | the hostname of the instance, by default the included terminal emulator shows this as the prompt text|
| filesystem       | No       | {}            | an object to represent the file system, any classes that extend Command will be treated as binaries it is probably best to use the included [exportFileSystem](bin/Readme.md) cli application to convert a directory to a filesystem object |
| cwd             | No       | '/'           | the starting CWD for the shell, this affects relative paths to files, binaries and directories just like in any other shell |

you may also wish to implement your own terminal emulator, are use the Shell directly within node CLI
in which case you can use just Shell by requiring:
```js
const Shell = require('brsh');
```

the Shell class can be implemented like so:
```js
const shell = new Shell({
    profile: '/root/.profile',
    cwd: '/root',
    filesystem: require('./filesystem')
});
```

the following methods and Events are available to interact with the shell instance

## Shell Public Methods
| Method        | variables                     | description |
| ------        | ---------                     | ----------- |
| onCommand     | `String` command              | a command to run in the shell e.g. `ls -al ./root` |
| tabCompletion | `String` completion candidate | a candidate for completion, for instance `./test/compl`, an array will be returned of possible completion strings |
| getPrompt     |                               | returns the current hostname and cwd |
| destroy       |                               | destroys the instance of the Shell |
| clear         |                               | cases the clear event to fire |

## Shell Events
| Event    | variables       | description |
| ------   | ---------       | ----------- |
| stdOut   | `String` line   | a single line of standard output from the shell to display to the user |
| stdErr   | `String` line   | a single line of standard error from the shell to display to the user |
| exitCode | `Number` code   | the exit code of any command run in the shell |
| status   | `String` Status | Shell status, this should be listened to to check if commands can be accepted, state can be one of: Shell.STATUS_READY or Shell.STATUS_WORKING = 'WORKING', listen for Shell.STATUS_READY to show a prompt to use the user
| clear    |                 | this event is fired to tell the Terminal emulator to clear the screen |
| exit     | `Number` code   | this event if fired when the terminal is destroyed, the code contains the final status code from the shell instance |

an example implementation of this shell running as a CLI can be found [here](demo/cli.js)

# Builtin and Local commands

these are in general simplified versions of what you will find in a standard unix shell

* cat
* echo
* ls

* alias
* cd
* clear
* export
* source
* which
* exit

## adding new commands:
new commands can be added by creating a class that extends Command, you can either access command as a Static property of Shell:
```js
class Test extends Shell.Command {
    ...
}
```

or Require Command directly:
```js
const Command = require('shell.js/lib/Command');

class Test extends Command {
    ...
}
```

for more on writing commands [see the docs here](lib/Readme.md#extending-command)

## Writing Scripts

to create a script you must first set the Shebang interpreter to `#!/sh.js` as the first line of the file

you may then run any commands in the system which will run as part of the script.

it is important to note that scripts run in a sub-shell and do not share context, if you wish from context changes from your script to persist you will need to use the source command like in Unix.

a final note, if you are using [exportFileSystem](bin/Readme.md) you must not set the file extension of a script to `.js` as this will cause to to be interpreted as javascript rather than a script string

## More Examples
On my website I have extended the functionality adding some simple extra utilities such as an ANSI image viewer and a markdown parser based on opensource node cli utilites.

[See the Site in action here](https://piratemedia.tv/)

[Github Source Code here](https://github.com/eliotstocker/piratemedia.tv)
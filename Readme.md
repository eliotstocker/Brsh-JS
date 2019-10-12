# BRowserSHell (brsh)
[![npm version](https://badge.fury.io/js/brsh.svg)](https://badge.fury.io/js/brsh)

An extensible shell written in Javascript with an accompanying terminal emulator

[Demo](http://eliotstocker.github.io/Brsh-JS/)

## What is it?
A Unix like Shell backend and Terminal Emulator that allows you top create a Terminal within you webapp.

## Why?
No idea, you tell me

## Known Issues
* Input on android is not working
* some tab completion isn't working quite right
* scripting isn't complete yet, if, while etc not implemented
* commands cant currently stream output, it is only returned once the app process finishes

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
| profile         | No       |               | a script to run before user interactivity (see [scripts](#writing-scripts)) |
| hostname        | No       | 'browser'     | the hostname of the instance, by default the included terminal emulator shows this as the prompt text|
| filesystem      | No       | {}            | an object to represent the file system, any classes that extend Command will be treated as binaries it is probably best to use the included [exportFileSystem](bin/Readme.md) cli application to convert a directory to a filesystem object |
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
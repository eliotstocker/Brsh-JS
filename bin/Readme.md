# Export File System

the export file system command can be used to export a local folder structure for use as a filesystem in Shell.js

## What Will it Do?

it will travers the directory structure from the provided base path, and import all files based on the following rules:

* Javascript files (.js): imported as node modules, whatever they export will be available to Shell JS, this is really useful for adding new commands just make sure you set module.exports to your Command class
* WebAssembly files (.wasm): automatically wrapped as executable `WasmCommand` binaries (especially when placed in `/bin`) or stored as raw binary files
* Binary files (.jpg, .png, .bmp, .pdf, .zip, etc.): stored as `BinaryFile` instances (or raw zero-overhead byte slices when using `--binary` / `.brfs`)
* all other files: imported as UTF-8 string representations of the data inside (preserving Unix file permissions and symlinks)

## CLI options 

| name       | alias | variable      | description |
| ----       | ----- | --------      | ----------- |
| root       |       | `String` path | also the default option, this is the path to the root of your file system |
| variable   | v     | `String` name | final variable output name for instance if set to `filesystem` when this file is loaded in a browser it will be accessible at `window.filesystem` |
| output     | o     | `String` path | path for the output file (`.js` bundle or standalone `.brfs` binary container; if not set will output to stdout) |
| binary     | b     |               | emit an indexed `BRFS` binary container (`.brfs`) with raw binary payloads, permissions, and symlinks instead of base64-in-JS |
| compress   | c     |               | emit a gzip-compressed bundle alongside a browser decompression loader (legacy `.brsh` / `.brfs` mode) |
| pretty     | p     |               | if pretty is set we will disable code uglification and pretify the json directory structure | 
| hyperlinks | h     |               | enable experimental hyperlink support for application (this will pass through an environment variable to your filesystem FORCE_HYPERLINK some libraries will pick up on this and pass back ansi links) |

## how does it work

most of the heavy lifting is done by [browserify](http://browserify.org/) and the following awesome plugins:

* [Stringify](http://johnpostlethwait.github.io/stringify/)
* [Imgurify](https://github.com/asbjornenge/imgurify)
* [Bundle Collapser](https://github.com/substack/bundle-collapser)
* [Uglifyify](https://github.com/hughsk/uglifyify)
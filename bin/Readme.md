# Export File System

the export file system command can be used to export a local folder structure for use as a filesystem in Shell.js

## What Will it Do?

it will travers the directory structure from the provided base path, and import all files based on the following rules:

* Javascript files (.js): imported as node modules, whatever they export will be available to Shell JS, this is really useful for adding new commands just make sure you set module.exports to your Command class
* Image files (.jpg, .png, .bmp): imported as base64 representations of the binary data, this is useful if you wish to display/manipulate data around these sorts of files
* all other files: imported as string representations of the data inside

## CLI options 

| name     | alias | variable      | description |
| ----     | ----- | --------      | ----------- |
| root     |       | `String` path | also the default option, this is the path to the root of your file system |
| variable | v     | `String` name | final variable output name for instance if set to `filesystem` when this file is loaded in a browser it will be accessible at `window.filesystem` |
| output   | o     | `String` path | path for the output javascript file (if not set will output to stdout) |
| pretty   | p     |               | if pretty is set we will disable code uglification and pretify the json directory structure | 

## how does it work

most of the heavy lifting is done by [browserify](http://browserify.org/) and the following awesome plugins:

* [Stringify](http://johnpostlethwait.github.io/stringify/)
* [Imgurify](https://github.com/asbjornenge/imgurify)
* [Bundle Collapser](https://github.com/substack/bundle-collapser)
* [Uglifyify](https://github.com/hughsk/uglifyify)
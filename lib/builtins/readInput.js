'use strict';

//reads a file (or stdin for '-' / no path) for a builtin, reports errors on the command itself.
//returns the text, or null if it couldnt be read
function readInput(cmd, path, label) {
    if(path === undefined || path === '-') {
        if(typeof cmd.stdin !== 'string') {
            cmd.stdErr = `${label}: no input`;
            cmd.exitCode = 1;
            return null;
        }
        return cmd.stdin;
    }

    const file = cmd.fs.getFileByPath(path);
    if(file === null || file === undefined) {
        cmd.stdErr = `${label}: ${path}: ${cmd.fs.exists(path) ? 'Permission denied' : 'No such file or directory'}`;
        cmd.exitCode = 1;
        return null;
    }
    if(file.constructor === Object) {
        cmd.stdErr = `${label}: ${path}: Is a directory`;
        cmd.exitCode = 1;
        return null;
    }
    return file.toString();
}

//a trailing newline terminates the last line rather than starting a new one
function toLines(text) {
    if(text === '') {
        return [];
    }
    return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

module.exports = {readInput, toLines};

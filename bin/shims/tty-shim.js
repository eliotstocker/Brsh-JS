exports.isatty = function () { return true; };

function ReadStream() {
    throw new Error('tty.ReadStream is not implemented');
}
exports.ReadStream = ReadStream;

function WriteStream() {
    throw new Error('tty.WriteStream is not implemented');
}
exports.WriteStream = WriteStream;
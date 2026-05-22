const ansiColors = require('ansi-colors');
const Command = require('../../../lib/Command');

class Ansitest extends Command {
    get requiresFilesystem() {
        return false;
    }

    link(url, text) {
        const OSC = '\x1B]';
        const BEL = '\x07';

        return [
            OSC,
            '8;;',
            url,
            BEL,
            text,
            OSC,
            '8;;',
            BEL
        ].join('');
    }

    run() {
        console.log("running ansitest");
        const lines = [
            ansiColors.black("Black"),
            ansiColors.bgBlack("Black Background"),
            ansiColors.blue("Blue"),
            ansiColors.bgBlue("Blue Background"),
            ansiColors.cyan("Cyan"),
            ansiColors.bgCyan("Cyan Background"),
            ansiColors.green("Green"),
            ansiColors.bgGreen("Green Background"),
            ansiColors.magenta("Magenta"),
            ansiColors.bgMagenta("Magenta Background"),
            ansiColors.red("Red"),
            ansiColors.bgRed("Red Background"),
            ansiColors.white("White"),
            ansiColors.bgWhite("White Background"),
            ansiColors.yellow("Yellow"),
            ansiColors.bgYellow("Yellow Background"),

            ansiColors.bold("Bold"),
            ansiColors.dim("Dim"), //not yet supported
            ansiColors.inverse("Inverse"), //not yet supported
            ansiColors.italic("Italic"),
            ansiColors.strikethrough("StrikeThrough"),
            ansiColors.underline("Underline"),
            this.link('http://google.com', 'Link to Google')
        ];

        lines.forEach(line => this.stdOut = line);

        return Promise.resolve();
    }
}

module.exports = Ansitest;
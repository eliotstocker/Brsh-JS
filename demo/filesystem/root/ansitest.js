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
        const lines = [
            ansiColors.black("Black"),
            ansiColors.bgblack("Black Background"),
            ansiColors.blue("Blue"),
            ansiColors.bgblue("Blue Background"),
            ansiColors.cyan("Cyan"),
            ansiColors.bgcyan("Cyan Background"),
            ansiColors.green("Green"),
            ansiColors.bggreen("Green Background"),
            ansiColors.magenta("Magenta"),
            ansiColors.bgmagenta("Magenta Background"),
            ansiColors.red("Red"),
            ansiColors.bgred("Red Background"),
            ansiColors.white("White"),
            ansiColors.bgwhite("White Background"),
            ansiColors.yellow("Yellow"),
            ansiColors.bgyellow("Yellow Background"),

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
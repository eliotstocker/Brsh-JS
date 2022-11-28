'use strict';

const Block = require('./Block');

const caseRegex = /^case\s+("?[\w$]+"?)\s+in$/
const optionRegex = /^([\w'"]|\*)\)/; //TODO: Not working for strings containing "'", but not sure why

class OptionBlock {
    constructor(option) {
        this.isDefault = option === '*';
        this.optionValue = option;
        this.isClosed = false;
        this._content = [];
    }

    set content(line) {
        this._content = [
            ...this._content,
            line
        ];
    }
    get content() {
        return this._content;
    }
}

class Case extends Block {
    static matchBlock(input) {
        return caseRegex.test(input);
    }

    static matchBlockEnd(input) {
        return input === 'esac';
    }

    static matchOptionStart(input) {
        return optionRegex.test(input);
    }

    static matchOptionEnd(input) {
        return input === ';;';
    }

    run(block) {
        try {
            const evaluatedBlock = block.options.reduce((acc, option) => {
                let value = global.shell.replaceVariables(this.context, block.value, undefined);
                try {
                    value = eval(value); //TODO, this is quite danngerious, might need to do some sanitisation
                } catch (e) {
                    //do nothing
                }
                console.log(option.optionValue, '==', value);
                if (option.optionValue == value) {
                    return option;
                }

                if(acc == null && option.isDefault) {
                    return option;
                }

                return acc;
            }, null);

            if(!evaluatedBlock) {
                return Promise.resolve();
            }

            return this.runScriptBlock(evaluatedBlock.content);
        } catch (e) {
            return Promise.reject(e.message);
        }
    }

    parseInput() {
        try {
            return Promise.resolve(this.input.reduce((acc, rawLine) => {
                let line = rawLine.trim();
                let currentOption = acc.options.length && acc.options[acc.options.length - 1];

                if (Case.matchBlock(line)) {
                    const caseMatch = caseRegex.exec(line);
                    if(caseMatch) {
                        return {
                            ...acc,
                            value: caseMatch[1]
                        }
                    }
                }

                console.log(line, Case.matchOptionStart(line))
                if (Case.matchOptionStart(line)) {
                    if(currentOption && !currentOption.isClosed) {
                        throw new Error(`syntax error near ${line}`);
                    }

                    const optionMatch = optionRegex.exec(line);
                    currentOption = new OptionBlock(optionMatch[1]);
                    acc.options.push(currentOption);
                    line = line.replace(optionRegex, '').trim();
                }

                if (Case.matchOptionEnd(line)) {
                    currentOption.isClosed = true;
                    return acc;
                }

                if (Case.matchBlockEnd(line)) {
                    this.blockComplete = true;
                    return acc;
                }

                if (line !== '') {
                    if(!currentOption && !currentOption.isClosed) {
                        throw new Error(`syntax error expected ')' near ${line}`);
                    }
                    currentOption.content = line;
                }

                return acc;
                }, {options: []}));
        } catch(e) {
            this.exitCode = 1;
            this.stdErr = e.message;
            this.blockComplete = true;
            this.exitEarly = true;
            return Promise.resolve(this.result)
        }
    }
}

module.exports = Case;
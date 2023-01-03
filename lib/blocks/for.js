'use strict';

const Block = require('./Block');
const While = require('./while');

class For extends Block {
    static matchBlock(input) {
        return input.startsWith('for') && input.includes('in');
    }

    static matchBlockEnd(input) {
        return input === 'done';
    }

    run(block) {
        return block.iterable.reduce((acc, item) => {
            return acc.then(() => {
                    this.context.setVar(block.it, item);
                    if(this.subShell) {
                        this.subShell.context.source(this.context);
                    }
                })
                .then(() => this.runScriptBlock(block.content));
        }, Promise.resolve());
    }

    parseInput() {
        try {
            let forSt = false;
            let doSt = false;
            let childBlock = false;
            return Promise.resolve(this.input.reduce((acc, rawLine) => {
                let line = rawLine.trim();

                if (While.matchBlock(line) || For.matchBlock(line)) {
                    if(!forSt) {
                        forSt = true;
                        return {
                            ...acc,
                            ...this._parseInteration(line)
                        }
                    }

                    childBlock = true;
                }

                if (line.startsWith('do') && !line.startsWith('done') && !childBlock) {
                    doSt = true;
                    line = line.replace('do', '').trim();
                }

                if (For.matchBlockEnd(line)) {
                    if(childBlock) {
                        childBlock = false;
                    } else {
                        this.blockComplete = true;
                        return acc;
                    }
                }

                if(line !== '') {
                    if(!forSt || !doSt) {
                        throw new Error(`syntax error, expected "do", got: "${line}"`);
                    }

                    return {
                        ...acc,
                        content: [...acc.content, line]
                    }
                }

                return acc;
                }, {content: []}));
        } catch(e) {
            console.error(e);
            this.exitCode = 1;
            this.stdErr = e.message;
            this.blockComplete = true;
            this.exitEarly = true;
            return Promise.resolve(this.result)
        }
    }

    _parseInteration(input) {
        const matcher = /^for\s+(\w+)\s+in\s+([\w$ ]+)$/;
        const matches = matcher.exec(input);

        if(!matches || matches.length < 3) {
            throw new Error(`invalid for syntax near: ${input}`);
        }

        return {
            it: matches[1],
            iterable: global.shell.replaceVariables(this.context, matches[2], 'undefined').split(/\s+/)
        }
    }
}

module.exports = For;
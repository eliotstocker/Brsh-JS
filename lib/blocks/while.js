'use strict';

const Block = require('./Block');

class While extends Block {
    static matchBlock(input) {
        return input.startsWith('while [') && input.endsWith(']');
    }

    static matchChildBlock(input) {
        return (input.startsWith('for') && input.includes('in')) || (input.startsWith('while [') && input.endsWith(']'))
    }

    static matchBlockEnd(input) {
        return input === 'done';
    }

    run(block) {
        const evaluateWhile = () => {
            if(this._evaluateStatements(block.statements)) {
                return this.runScriptBlock(block.content).then(evaluateWhile);
            }
            return Promise.resolve();
        };

        return evaluateWhile();
    }

    parseInput() {
        try {
            let whileSt = false;
            let doSt = false;
            let childBlock = false;
            return Promise.resolve(this.input.reduce((acc, rawLine) => {
                let line = rawLine.trim();

                if (While.matchBlock(line) || While.matchChildBlock(line)) {
                    if(!whileSt) {
                        whileSt = true;
                        return {
                            ...acc,
                            statements: this._parseLogic(line)
                        }
                    }

                    childBlock = true;
                }

                if (line.startsWith('do') && !line.startsWith('done') && !childBlock) {
                    doSt = true;
                    line = line.replace('do', '').trim();
                }

                if (While.matchBlockEnd(line)) {
                    if(childBlock) {
                        childBlock = false;
                    } else {
                        this.blockComplete = true;
                        return acc;
                    }
                }

                if(line !== '') {
                    if(!whileSt || !doSt) {
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
            this.exitCode = 1;
            this.stdErr = e.message;
            this.blockComplete = true;
            this.exitEarly = true;
            return Promise.resolve(this.result)
        }
    }

    _parseLogic(input) {
        const matcher = /^while \[\[? (.+?) \]\]?$/g;
        const matches = matcher.exec(input);

        if(!matches || matches.length < 2) {
            throw new Error(`invalid while syntax near: ${input}`);
        }

        const statements = matches[1].split(/ \]\] (?:&&|\|\|) \[\[ /g);

        return statements.map(this._parseOperator);
    }

    _parseOperator(statement) {
        return statement
        .replace("=", "==")
        .replace("-eq", "==")
        .replace("-ne", "!=")
        .replace("-gt", ">")
        .replace("\>", ">")
        .replace("-ge", ">=")
        .replace("-lt", "<")
        .replace("\<", "<")
        .replace("-le", "<=")
        .replace("-z", "== undefined")
        .replace("-n", "!= undefined")
    }

    _evaluateStatements(statements) {
        //TODO: we need to add logic for and, currently always or
        return statements.reduce((acc, statement) => {
            const preparedStatement = global.shell.replaceVariables(this.context, statement, 'undefined')
            .split(' ')
            .map(part => part !== 'undefined' && /^\w+$/.test(part) ? `'${part}'`: part)
            .join(' ');

            if(!acc) {
                return eval(preparedStatement);
            }
            return acc;
            }, false);
    }
}

module.exports = While;
const Block = require('./Block');

class IfBlock {
    constructor(type, statements) {
        this.type = type;
        this.statements = statements;
        this._readyForContent = type === 'else';
        this._content = [];
    }

    set content(line) {
        if(!this._readyForContent) {
            throw new Error(`syntax error, expected "then", got: "${line}"`);
        }

        this._content = [
            ...this._content,
            line
        ];
    }
    get content() {
        return this._content;
    }

    set readyForContent(bool) {
        this._readyForContent = bool;
    }

    evaluateStatements() {
        if(this.type === 'else') {
            return true;
        }

        //TODO: we need to add logic for and, currently always or
        return this.statements.reduce((acc, statement) => {
            if(!acc) {
                return eval(statement);
            }
            return acc;
        }, false);
    }
}

class If extends Block {
    static matchBlock(input) {
        return input.startsWith('if [') && input.endsWith(']');
    }

    static matchElif(input) {
        return input.startsWith('elif [') && input.endsWith(']');
    }

    static matchBlockEnd(input) {
        return input === 'fi';
    }

    run(block) {
        const evaluatedBlock = block.reduce((acc, sub) => {
            if(!acc && sub.evaluateStatements()) {
                return sub;
            }
            return acc;
        }, undefined);

        if(!evaluatedBlock) {
            return Promise.resolve();
        }

        return this.runScriptBlock(evaluatedBlock.content);
    }

    parseInput() {
        try {
            return Promise.resolve(this.input.reduce((acc, rawLine) => {
                let line = rawLine.trim();

                let currentBlock = acc.length && acc[acc.length -1];
                if (If.matchBlock(line)) {
                    currentBlock = new IfBlock('if', this._parseLogic(line));
                    return [currentBlock];
                }

                if (If.matchElif(line)) {
                    currentBlock = new IfBlock('elif', this._parseLogic(line));
                    return [
                        ...acc,
                        currentBlock
                    ];
                }
                if (line.startsWith('else')) {
                    line = line.replace('else', '').trim();
                    currentBlock = new IfBlock('else');
                    acc = [
                        ...acc,
                        currentBlock
                    ];
                }

                if (line.startsWith('then')) {
                    currentBlock.readyForContent = true;
                    line = line.replace('then', '').trim();
                }

                if (If.matchBlockEnd(line)) {
                    this.blockComplete = true;
                    return acc;
                }

                if(line !== '') {
                    currentBlock.content = line;
                }

                return acc;
                }, []));
        } catch(e) {
            this.exitCode = 1;
            this.stdErr = e.message;
            this.blockComplete = true;
            this.exitEarly = true;
            return Promise.resolve(this.result)
        }
    }

    _parseLogic(input) {
        const matcher = /^(?:el)?if \[\[? (.+?) \]\]?$/g
        const matches = matcher.exec(input);

        if(matches.length < 1) {
            throw new Error("invalid syntax!")
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
}

module.exports = If;
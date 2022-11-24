const Block = require('./Block');

const shortSigRegex = /^(\w+)\s*\(\)\s+{/g;
const longSigRegex = /^function\s+(\w+)\s+{/g;
class Func extends Block {
    static matchBlock(input) {
        return shortSigRegex.test(input) || longSigRegex.test(input);
    }

    static matchBlockEnd(input) {
        return input === '}';
    }

    run(block) {
        this.context.setFunction(block.name, block.content.join('\n'));
        return Promise.resolve();
    }

    parseInput() {
        return Promise.resolve(this.input.reduce((acc, rawLine) => {
            let line = rawLine.trim();

            if(!acc.name) {
                const funcSigShort = shortSigRegex.exec(line);
                const funcSigLong = longSigRegex.exec(line);
                if (funcSigShort) {
                    acc.name = funcSigShort[1];
                    line = line.replace(shortSigRegex, '').trim();
                } else if (funcSigLong) {
                    acc.name = funcSigLong[1];
                    line = line.replace(longSigRegex, '').trim();
                }
            }

            if (acc.name) {
                if(Func.matchBlockEnd(line)) {
                    this.blockComplete = true;
                    return acc;
                }

                if (line !== '') {
                    return {
                        ...acc,
                        content: [
                            ...acc.content,
                            line
                        ]
                    }
                }
            }

            return acc;
        }, {content: []}));
    }
}

module.exports = Func;
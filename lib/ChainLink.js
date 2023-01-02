'use strict';

class ChainLink {
    constructor(command, connector = ChainLink.CONNECTOR_NONE) {
        this.connector = connector;
        this.command = command.trim();
    }

    chain(preseding, runner) {
        return preseding
            .then(code => {
                console.log('last code', code);
                if(this.connector === ChainLink.CONNECTOR_OR) {
                    if(code > 0) {
                        return runner(this.command);
                    }
                } else if(this.connector === ChainLink.CONNECTOR_AND) {
                    if(code < 1) {
                        return runner(this.command);
                    }
                } else if(this.connector === ChainLink.CONNECTOR_NONE) {
                    console.log('run now');
                    return runner(this.command);
                }
                return code;
            }).catch(console.error);
    }

    startsWith(prefix) {
        return this.command.startsWith(prefix);
    }

    endsWith(suffix) {
        return this.command.endsWith(suffix);
    }


    [Symbol.iterator]() {
        let index = -1;

        return {
            next: () => ({ value: this.command[++index], done: index >= this.command.length })
        };
    };
}

ChainLink.CONNECTOR_OR = 'or';
ChainLink.CONNECTOR_AND = 'and';
ChainLink.CONNECTOR_NONE = '';

module.exports = ChainLink;
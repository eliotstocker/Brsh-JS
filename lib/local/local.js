'use strict';

const LocalCommand = require('./LocalCommand');

//scopes are frames pushed by the function runner in ScriptCommand, it puts the old values back on return
class Local extends LocalCommand {
    static get name() { return 'local'; }

    run() {
        const frames = this.context.localFrames;
        if(!frames || frames.length < 1) {
            this.stdErr = 'local: can only be used in a function';
            this.exitCode = 1;
            return Promise.resolve();
        }

        const frame = frames[frames.length -1];
        const {vars} = this.context;
        this.arguments.forEach(arg => {
            const eq = arg.indexOf('=');
            const name = eq > -1 ? arg.slice(0, eq) : arg;
            if(!/^[A-Za-z_]\w*$/.test(name)) {
                this.stdErr = `local: '${arg}': not a valid identifier`;
                this.exitCode = 1;
                return;
            }

            //only remember the value from before the first local in this call
            if(!Object.prototype.hasOwnProperty.call(frame, name)) {
                frame[name] = {had: name in vars, value: vars[name]};
            }
            this.context.setVar(name, eq > -1 ? arg.slice(eq + 1) : '');
        });
        return Promise.resolve();
    }
}

module.exports = Local;

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Shell = require('../index.js');

/**
 * Creates a shell instance and resolves once it emits STATUS_READY.
 */
export function createShell(options = {}) {
    return new Promise((resolve) => {
        const shell = new Shell({ filesystem: {}, ...options });
        shell.once('status', () => resolve(shell));
    });
}

/**
 * Runs a command and returns collected stdout/stderr and final exit code.
 */
export async function run(shell, command) {
    const output = [];
    const errors = [];

    const onOut = (line) => output.push(line);
    const onErr = (line) => errors.push(line);

    shell.on('stdOut', onOut);
    shell.on('stdErr', onErr);

    await shell.onCommand(command);

    shell.removeListener('stdOut', onOut);
    shell.removeListener('stdErr', onErr);

    return { output, errors, exitCode: shell.lastCode };
}

import _Shell from 'brsh';
import _Terminal from 'brsh/terminal';
import Pico from './pico.js';

// @originjs/vite-plugin-commonjs wraps CJS module.exports in a namespace
// object in production builds, so unwrap .default if present.
const Shell = _Shell?.default ?? _Shell;
const Terminal = _Terminal?.default ?? _Terminal;

async function init() {
    // Support both plain-object (uncompressed) and Promise (compressed) fs exports
    const fsExport = await Promise.resolve(globalThis.fs);
    const filesystem = fsExport?.filesystem;
    const permissions = fsExport?.permissions;

    if (!filesystem) {
        throw new Error('Demo filesystem was not loaded');
    }

    globalThis.Shell = Shell;
    globalThis.Terminal = Terminal;

    const term = new Terminal({
        el: document.body,
        profile: '/root/.profile',
        cwd: '/root',
        filesystem,
        permissions,
        cursor: 'blink',
        lineWrap: true,
        outputAnimation: 'type',
        animateSpeed: 2
    });

    globalThis.term = term;

    // Register demo-only interactive commands
    term.cli.context.setCommand(Pico);
}

init();
import _Shell from 'brsh';
import _Terminal from 'brsh/terminal';

// @originjs/vite-plugin-commonjs wraps CJS module.exports in a namespace
// object in production builds, so unwrap .default if present.
const Shell = _Shell?.default ?? _Shell;
const Terminal = _Terminal?.default ?? _Terminal;

const filesystem = globalThis.fs?.filesystem;
const permissions = globalThis.fs?.permissions;

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
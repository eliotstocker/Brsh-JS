import Shell from 'brsh';
import Terminal from 'brsh/terminal';

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
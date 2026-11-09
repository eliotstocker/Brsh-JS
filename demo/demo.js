import _Shell from 'brsh';
import _Terminal from 'brsh/terminal';
import _Wbt from 'brsh/wbt';
import Pico from './pico.js';

// @originjs/vite-plugin-commonjs wraps CJS module.exports in a namespace
// object in production builds, so unwrap .default if present.
const Shell = _Shell?.default ?? _Shell;
const Terminal = _Terminal?.default ?? _Terminal;
const Wbt = _Wbt?.default ?? _Wbt;

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
    globalThis.Wbt = Wbt;

    const termEl = document.getElementById('terminal') || document.body;

    const term = new Terminal({
        el: termEl,
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

    // Optional dynamic title update if terminal emits title changes
    const titleEl = document.getElementById('terminal-title');
    if (titleEl && typeof term.onTitleChange === 'function') {
        term.onTitleChange((title) => {
            titleEl.textContent = title || 'brsh \u2014 BRowserSHell';
        });
    }

    // Window controls
    const windowEl = document.querySelector('.terminal-window');
    const btnMaximize = document.getElementById('btn-maximize');
    const btnClose = document.getElementById('btn-close');

    if (btnMaximize && windowEl) {
        btnMaximize.addEventListener('click', () => {
            windowEl.classList.toggle('is-maximized');
        });
    }

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            if (typeof term._emitInput === 'function') {
                term._emitInput('clear\r');
            } else {
                term.clear();
            }
        });
    }

    // Register demo-only optional commands
    term.cli.context.setCommand(Pico);
    term.cli.context.setCommand(Wbt);
}

init();

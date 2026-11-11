'use strict';

const Command = require('./Command');

/**
 * Base class for interactive full-screen terminal applications (e.g. text editors).
 *
 * Subclasses:
 * - Must implement `run()` — return a Promise that resolves when the app exits.
 * - Must implement `onInput(key)` — receives keystroke strings:
 *     - Printable characters: 'a', 'B', '1', ' ', etc.
 *     - Special keys:  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
 *                      'Enter', 'Backspace', 'Delete', 'Escape',
 *                      'Home', 'End', 'PageUp', 'PageDown', 'Tab'
 *     - Ctrl combos:   '^A' through '^Z' (caret + uppercase letter)
 * - Should render by setting `this.stdOut = screenString` then calling `this.flush()`.
 *   Start the screen string with '\x1b[2J\x1b[H' to signal a full-screen replace.
 *   Send the entire screen as ONE stdOut assignment (multi-line string) for efficiency.
 *
 * Terminal size is available via `this.terminalSize` → `{ cols, rows }`.
 */
class InteractiveCommand extends Command {
    /**
     * Tells Shell to route all keystrokes here via onInput().
     */
    get captureInput() {
        return true;
    }

    /**
     * Tells Shell/Terminal that this command owns the full screen.
     * Terminal will hide the normal <ul> output list and show a <pre>
     * rendering surface for the duration of this command.
     */
    get interactive() {
        return true;
    }

    /**
     * Current terminal dimensions reported by the host Terminal, or 80×24 fallback.
     * @returns {{ cols: number, rows: number }}
     */
    get terminalSize() {
        const cols = (this.stdout && this.stdout.columns)
            || (this.stdinStream && this.stdinStream.columns)
            || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('COLUMNS'), 10))
            || 80;
        const rows = (this.stdout && this.stdout.rows)
            || (this.stdinStream && this.stdinStream.rows)
            || (this.context && typeof this.context.getVar === 'function' && parseInt(this.context.getVar('LINES'), 10))
            || 24;
        return { cols, rows };
    }

    _enterAltScreen() {
        if (this._inAltScreen) return;
        this._inAltScreen = true;
        if (this.stdinStream) this.stdinStream.setRawMode(true);
        if (this.stdout) this.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
    }

    _exitAltScreen() {
        if (!this._inAltScreen) return;
        this._inAltScreen = false;
        if (this.stdinStream) this.stdinStream.setRawMode(false);
        if (this.stdout) this.stdout.write('\x1b[0m\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h');
    }

    kill(signal = 'SIGINT') {
        this._exitAltScreen();
        super.kill(signal);
    }

    runCommand() {
        if (this.interactive) {
            this._enterAltScreen();
        }
        return super.runCommand().finally(() => {
            this._exitAltScreen();
        });
    }
}

module.exports = InteractiveCommand;

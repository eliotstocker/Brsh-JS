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
        const cols = parseInt(this.context.getVar('COLUMNS'), 10) || 80;
        const rows = parseInt(this.context.getVar('LINES'), 10) || 24;
        return { cols, rows };
    }
}

module.exports = InteractiveCommand;

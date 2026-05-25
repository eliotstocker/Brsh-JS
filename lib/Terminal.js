'use strict';

const Shell = require('Shell');
const _AnsiUp = require('ansi_up');
// ansi_up is a pre-compiled ESM→CJS shim: module.exports = { default: AnsiUp }
const AnsiUp = _AnsiUp?.default ?? _AnsiUp;

const HISTORY_FILE = '/.brsh_history';

class Terminal {
    constructor(options) {
        const {
            el,
            font = 'Roboto Mono',
            cursor = 'none',
            outputAnimation = 'none',
            animateSpeed = 1,
            onExit = null,
            mobileInput = 'click',
            lineWrap = false
        } = options;

        if(!el) {
            throw new Error('you must set `el` option');
        }

        if(!['none', 'block', 'blink'].includes(cursor)) {
            throw new Error('cursor value must be one of: \'none\', \'block\', \'blink\'');
        }

        if(!['none', 'type'].includes(outputAnimation)) {
            throw new Error('outputAnimation value must be one of: \'none\', \'type\'');
        }

        if(!Number.isInteger(animateSpeed) || animateSpeed < 1 || animateSpeed > 20) {
            throw new Error('animateSpeed value must be between 1 and 20');
        }

        this._exitFn = onExit;
        this._cursor = cursor;
        this._outputAnimation = outputAnimation;
        this._animateSpeed = animateSpeed;
        this._lineWrap = lineWrap;
        this._working = false;
        this.cli = new Shell(options);
        this._buffer = [];
        this._cursorPos = 0;
        this._history = [];
        this._historyPos = null;
        this._savedInput = null;
        this._historyLoaded = false;
        this._el = el;
        this._ansi = new AnsiUp();

        this._ansi.use_classes = true;
        this._ansi.url_whitelist = {
            http: true,
            https: true,
            tel: true,
            mailto: true
        }

        this._setupDom(this._el, font);
        this._attachShellListeners();

        if(mobileInput === 'click') {
            this._mobileInput();
        }
    }

    sendKey(key, modifiers = {}) {
        const { alt = false, ctrl = false } = modifiers;
        const onUpdate = this._setCurrentLine.bind(this);

        const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'];
        if (navKeys.includes(key) || (ctrl && ['a', 'e', 'u', 'k'].includes(key.toLowerCase()))) {
            this._navKeyEvent(onUpdate, { key, altKey: alt, ctrlKey: ctrl });
        } else {
            this._keyEvent(onUpdate, key);
        }
    }

    onCommand(command) {
        if(!this._currentLine) {
            return setTimeout(this.onCommand.bind(this, command), 10);
        }

        const onUpdate = this._setCurrentLine.bind(this);
        this._cursorPos = command.length;
        onUpdate(Array.from(command));
        this.cli.onCommand(command);
    }

    _mobileInput() {
        const input = document.createElement('input');
        input.type = 'text';
        input.style.position = 'absolute';
        input.style.left = '-9999999px';
        this._el.appendChild(input);
        this._mobileInputBuffer = '';

        this._el.addEventListener('click', () => {
            input.focus();
        });

        input.addEventListener('keypress', e => {
            if(e.key === 'Enter') {
                input.value = '';
                this._mobileInputBuffer = input.value
            }
        });

        const onUpdate = this._setCurrentLine.bind(this);

        input.addEventListener('keyup', (e) => {
            if(e.key === 'Unidentified') {
                if (input.value.length < this._mobileInputBuffer.length) {
                    //backspace
                    this._keyEvent(onUpdate, 'Backspace');
                } else if (input.value.length > this._mobileInputBuffer.length) {
                    //a new character
                    const char = input.value[input.value.length - 1];
                    this._keyEvent(onUpdate, char.toLowerCase());
                }

                this._mobileInputBuffer = input.value;
            }
        });
    }

    _setupDom(parent, font = 'Roboto Mono') {
        const style = document.createElement('link');
        style.href = `https://fonts.googleapis.com/css?family=${encodeURIComponent(font)}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
        style.rel = 'stylesheet';
        document.head.appendChild(style);

        this._cmdList = document.createElement('ul');
        this._cmdList.style.fontFamily = `'${font}', monospace`;
        this._cmdList.style.listStyle = 'none';
        this._cmdList.style.padding = '0';
        if (this._lineWrap) {
            this._cmdList.classList.add('terminal--wrap');
        }
        parent.appendChild(this._cmdList);

        // Full-screen surface for interactive commands (pico, etc.)
        this._screen = document.createElement('pre');
        this._screen.className = 'terminal__screen';
        this._screen.style.fontFamily = `'${font}', monospace`;
        parent.appendChild(this._screen);

        // Hidden single-character span for measuring character cell dimensions
        this._charMeasure = document.createElement('span');
        this._charMeasure.className = 'terminal__char-measure';
        this._charMeasure.textContent = 'X';
        this._charMeasure.setAttribute('aria-hidden', 'true');
        parent.appendChild(this._charMeasure);

        // Measure on first paint, then track container resizes
        setTimeout(() => this._measureAndSetSize(), 0);
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => this._measureAndSetSize()).observe(parent);
        }
    }

    _newPrompt(callback) {
        this._clearCursor();
        this._currentLine = document.createElement('li');
        this._cmdList.appendChild(this._currentLine);
        if(callback) {
            callback();
        }
        this._autoScroll();
    }

    _print(data, type = 'out') {
        if(this._outputAnimation === 'none') {
            const line = document.createElement('li');
            line.classList.add('terminal__line');
            line.classList.add(type);

            line.innerHTML = this._ansi.ansi_to_html(data);

            this._cmdList.appendChild(line);
            this._autoScroll();
        } else {
            this._animateType(data, type);
        }
    }

    _autoScroll() {
        if(this._el.scrollTop + this._el.offsetHeight >= this._el.scrollHeight -50) {
            this._el.scrollTo(0, this._el.scrollHeight)
        }
    }

    _animateType(text, type) {
        if(this._animating) {
            return requestAnimationFrame(this._animateType.bind(this, text, type));
        }

        const line = document.createElement('li');
        line.classList.add('terminal__line');
        line.classList.add(type);
        this._cmdList.appendChild(line);

        let content
        try {
            content = this._ansi.ansi_to_html(text);
        } catch(e) {
            content = text
        }
        this._animating = line;

        let index = 0;
        const timer = setInterval(() => {
            const char = content.charAt(index);

            if(char === '<') {
                index = content.indexOf('>', index);
            }

            line.innerHTML = content.substr(0, index);

            let increment = 0;
            while(increment < this._animateSpeed) {
                index++;
                if(content.charAt(index) === '<') {
                    index = content.indexOf('>', index);
                }
                increment++;
            }

            if(index >= content.length - 1) {
                line.innerHTML = content;
                clearInterval(timer);
                delete this._animating;
            }
            this._autoScroll();
        }, 10);
    }

    _clearOutput() {
        const lines = this._cmdList.querySelectorAll('li');
        lines.forEach(line => this._cmdList.removeChild(line));
    }

    _clearLine(type) {
        const lines = this._cmdList.querySelectorAll(`li.terminal__line.${type}`);
        lines.forEach(line => this._cmdList.removeChild(line));
    }

    _setCurrentLine(buffer) {
        const pos = Math.min(this._cursorPos, buffer.length);

        while (this._currentLine.firstChild) {
            this._currentLine.removeChild(this._currentLine.firstChild);
        }

        const prompt = `${this.cli.getPrompt()} `;

        if (this._cursor !== 'none') {
            const before = buffer.slice(0, pos).join('');
            const atChar = pos < buffer.length ? buffer[pos] : ' ';
            const after = buffer.slice(pos + 1).join('');

            this._currentLine.appendChild(document.createTextNode(prompt + before));

            const cursor = document.createElement('span');
            cursor.textContent = atChar;
            cursor.classList.add('terminal__cursor');
            cursor.classList.add(this._cursor);
            this._currentLine.appendChild(cursor);

            if (after) {
                this._currentLine.appendChild(document.createTextNode(after));
            }
        } else {
            this._currentLine.innerText = `${prompt}${buffer.join('')}`;
        }
    }

    _clearCursor() {
        if(this._cursor !== 'none') {
            const cursor = document.querySelectorAll('.terminal__cursor');
            if(cursor.length) {
                cursor.forEach(c => c.parentElement.removeChild(c));
            }
        }
    }

    _statusCheck(status) {
        if(status === Shell.STATUS_READY) {
            if (this._interactive) {
                this._exitInteractiveMode();
            }
            this._working = false;
            if (!this._historyLoaded) {
                this._loadHistory();
                this._historyLoaded = true;
            }
            if(this._animating) {
                return requestAnimationFrame(this._statusCheck.bind(this, status));
            }
            this._newPrompt(this._setCurrentLine.bind(this, this._buffer));
        } else {
            this._clearCursor();
            this._working = true;
        }
    }

    _loadHistory() {
        try {
            const file = this.cli.context.fs._getFileRaw(HISTORY_FILE);
            if (file && typeof file === 'string' && file.length > 0) {
                this._history = file.split('\n').filter(l => l.length > 0);
            }
        } catch(e) {
            // No history file yet
        }
    }

    _saveHistory() {
        try {
            this.cli.context.fs._setFileRaw(HISTORY_FILE, this._history.join('\n'), true);
        } catch(e) {
            // Ignore persistence errors
        }
    }

    _navigateHistory(direction, onUpdate) {
        if (this._history.length === 0) return;

        if (direction === -1) {
            if (this._historyPos === null) {
                this._savedInput = [...this._buffer];
                this._historyPos = this._history.length - 1;
            } else if (this._historyPos > 0) {
                this._historyPos--;
            } else {
                return;
            }
            this._buffer = Array.from(this._history[this._historyPos]);
        } else {
            if (this._historyPos === null) return;
            if (this._historyPos < this._history.length - 1) {
                this._historyPos++;
                this._buffer = Array.from(this._history[this._historyPos]);
            } else {
                this._historyPos = null;
                this._buffer = this._savedInput ? [...this._savedInput] : [];
                this._savedInput = null;
            }
        }

        this._cursorPos = this._buffer.length;
        onUpdate(this._buffer);
    }

    _attachShellListeners() {
        this.cli.on('status', this._statusCheck.bind(this));

        this.cli.on('stdOut', line => {
            if (this._interactive) {
                this._renderInteractiveScreen(line);
            } else {
                this._print(line, 'out');
            }
        });

        this.cli.on('stdErr', line => {
            if (!this._interactive) {
                this._print(line, 'err');
            }
        });

        this.cli.on('clear', () => {
            this._clearOutput();
        });

        this.cli.on('interactive', () => {
            this._enterInteractiveMode();
        });

        this.cli.on('exit', code => {
            delete this.cli;
            if(typeof this._exitFn === 'function') {
                this._exitFn(code);
            }
        });

        this._listenForKeyEvents(this._setCurrentLine.bind(this), window);
    }

    _listenForKeyEvents(onUpdate, el) {
        window.addEventListener('keydown', e => {
            // Interactive mode: route ALL keystrokes to the running command
            if (this._interactive) {
                e.preventDefault();
                const key = this._buildInteractiveKey(e);
                if (key) this.cli.onInput(key);
                return;
            }

            if (e.keyCode === 9) {
                e.preventDefault();
            }

            const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'];
            if (navKeys.includes(e.key)) {
                e.preventDefault();
                this._navKeyEvent(onUpdate, e);
                return;
            }

            if (e.ctrlKey && ['a', 'e', 'u', 'k'].includes(e.key.toLowerCase())) {
                e.preventDefault();
                this._navKeyEvent(onUpdate, e);
            }
        });

        el.addEventListener('keyup', (e) => {
            if (this._interactive) return;
            this._keyEvent(onUpdate, e.key);
        });

        window.addEventListener('paste', (e) => {
            e.preventDefault();
            if (this._interactive) return;
            const text = (e.clipboardData || window.clipboardData).getData('text');
            if (!text) return;

            const segments = text.split(/\r?\n/);
            segments.forEach((segment, idx) => {
                const chars = segment.split('');
                this._buffer.splice(this._cursorPos, 0, ...chars);
                this._cursorPos += chars.length;

                if (idx < segments.length - 1) {
                    this._keyEvent(onUpdate, 'Enter');
                }
            });

            onUpdate(this._buffer);
        });
    }

    _buildInteractiveKey(e) {
        const key = e.key;
        // Skip bare modifier keys
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
        // Ctrl+letter → caret notation '^X'
        if (e.ctrlKey && key.length === 1) {
            return '^' + key.toUpperCase();
        }
        // All other keys passed as e.key strings ('ArrowUp', 'Enter', 'a', etc.)
        return key;
    }

    _wordLeft() {
        let pos = this._cursorPos;
        while (pos > 0 && this._buffer[pos - 1] === ' ') pos--;
        while (pos > 0 && this._buffer[pos - 1] !== ' ') pos--;
        return pos;
    }

    _wordRight() {
        let pos = this._cursorPos;
        const len = this._buffer.length;
        while (pos < len && this._buffer[pos] === ' ') pos++;
        while (pos < len && this._buffer[pos] !== ' ') pos++;
        return pos;
    }

    _navKeyEvent(onUpdate, e) {
        if (this._working || this._animating) return;

        const key = e.key;

        if (key === 'ArrowLeft') {
            if (e.altKey) {
                this._cursorPos = this._wordLeft();
            } else if (this._cursorPos > 0) {
                this._cursorPos--;
            }
            onUpdate(this._buffer);
        } else if (key === 'ArrowRight') {
            if (e.altKey) {
                this._cursorPos = this._wordRight();
            } else if (this._cursorPos < this._buffer.length) {
                this._cursorPos++;
            }
            onUpdate(this._buffer);
        } else if (key === 'Home' || (e.ctrlKey && key.toLowerCase() === 'a')) {
            this._cursorPos = 0;
            onUpdate(this._buffer);
        } else if (key === 'End' || (e.ctrlKey && key.toLowerCase() === 'e')) {
            this._cursorPos = this._buffer.length;
            onUpdate(this._buffer);
        } else if (key === 'Delete') {
            if (this._cursorPos < this._buffer.length) {
                this._buffer.splice(this._cursorPos, 1);
                onUpdate(this._buffer);
            }
        } else if (e.ctrlKey && key.toLowerCase() === 'u') {
            this._buffer.splice(0, this._cursorPos);
            this._cursorPos = 0;
            onUpdate(this._buffer);
        } else if (e.ctrlKey && key.toLowerCase() === 'k') {
            this._buffer.splice(this._cursorPos);
            onUpdate(this._buffer);
        } else if (key === 'ArrowUp') {
            this._navigateHistory(-1, onUpdate);
        } else if (key === 'ArrowDown') {
            this._navigateHistory(1, onUpdate);
        }
    }

    _keyEvent(onUpdate, key) {
        this._clearLine('autoComplete');
        if (this.cli.onInput(key)) {
            return;
        }

        if (key.length === 1) {
            this._buffer.splice(this._cursorPos, 0, key);
            this._cursorPos++;

            if (!this._working && !this._animating) {
                onUpdate(this._buffer);
            }
        } else if (key === 'Enter' && !this._working) {
            const command = this._buffer.join('');
            this._buffer = [];
            this._cursorPos = 0;
            this._historyPos = null;
            this._savedInput = null;

            if (command.trim()) {
                if (this._history[this._history.length - 1] !== command) {
                    this._history.push(command);
                }
                this._saveHistory();
            }

            this.cli.onCommand(command);
        } else if (key === 'Backspace') {
            if (this._cursorPos > 0) {
                this._buffer.splice(this._cursorPos - 1, 1);
                this._cursorPos--;

                if (!this._working && !this._animating) {
                    onUpdate(this._buffer);
                }
            }
        } else if (key === 'Tab' && !this._working && !this._animating) {
            const commandParts = this._buffer.join('').split(' ');
            const lastPath = commandParts.pop();

            const autoComplete = this.cli.tabCompletion(lastPath);
            if(autoComplete) {
                const {options, path} = autoComplete;

                if(options.length === 1) {
                    commandParts.push(`${path != null ? path.concat('/') : ''}${options[0]}`);
                    this._buffer = commandParts.join(' ').split('');
                } else {
                    this._print(options.join('  '), 'autoComplete');
                }

                this._cursorPos = this._buffer.length;
                onUpdate(this._buffer);
            }
        }
    }
    _enterInteractiveMode() {
        this._interactive = true;
        this._cmdList.style.display = 'none';
        this._screen.style.display = 'block';
        this._clearCursor();
    }

    _exitInteractiveMode() {
        this._interactive = false;
        this._screen.style.display = 'none';
        this._screen.innerHTML = '';
        this._cmdList.style.display = '';
    }

    _renderInteractiveScreen(text) {
        // Strip ANSI clear-screen and cursor-home/position sequences used as
        // full-screen replace signal. AnsiUp handles colours; we just drop the
        // cursor-control codes before passing to it.
        const cleaned = text
            .replace(/\x1b\[\d*J/g, '')       // erase in display (\x1b[2J etc.)
            .replace(/\x1b\[\d+;\d+H/g, '')   // cursor position row;col
            .replace(/\x1b\[H/g, '');          // cursor home (no args)
        try {
            this._screen.innerHTML = this._ansi.ansi_to_html(cleaned);
        } catch(e) {
            this._screen.textContent = cleaned;
        }
    }

    _measureAndSetSize() {
        if (!this._charMeasure || !this.cli) return;
        const charRect = this._charMeasure.getBoundingClientRect();
        const containerRect = this._el.getBoundingClientRect();
        if (!charRect.width || !charRect.height || !containerRect.width) return;
        const cols = Math.max(1, Math.floor(containerRect.width / charRect.width));
        const rows = Math.max(1, Math.floor(containerRect.height / charRect.height));
        if (cols !== this._lastCols || rows !== this._lastRows) {
            this._lastCols = cols;
            this._lastRows = rows;
            this.cli.setTerminalSize(cols, rows);
        }
    }
}

module.exports = Terminal;

//import css
require('../styles/terminal.css');

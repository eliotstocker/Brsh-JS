'use strict';

const Shell = require('Shell');
const AnsiUp = require('ansi_up');

class Terminal {
    constructor(options) {
        const {
            el,
            font = 'Roboto Mono',
            cursor = 'none',
            outputAnimation = 'none',
            animateSpeed = 1,
            onExit = null,
            mobileInput = 'click'
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
        this._working = false;
        this.cli = new Shell(options);
        this._buffer = [];
        this._el = el;
        this._ansi = new AnsiUp.default();

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


        input.addEventListener('keyup', (e) => {
            if(e.key === 'Unidentified') {
                if (input.value.length < this._mobileInputBuffer.length) {
                    //backspace
                    this._keyEvent(this._setCurrentLine.bind(this), 'Backspace');
                } else if (input.value.length > this._mobileInputBuffer.length) {
                    const char = input.value[input.value.length - 1];
                    this._keyEvent(this._setCurrentLine.bind(this), char);
                }

                this._mobileInputBuffer = input.value;
            }
        });
    }

    _setupDom(parent, font = 'Roboto Mono') {
        const style = document.createElement('link');
        style.href = `https://fonts.googleapis.com/css?family=${encodeURIComponent(font)}&display=swap`;
        style.rel = 'stylesheet';
        document.head.appendChild(style);

        this._cmdList = document.createElement('ul');
        this._cmdList.style.fontFamily = `'${font}', monospace`;
        this._cmdList.style.listStyle = 'none';
        this._cmdList.style.padding = '0';
        parent.appendChild(this._cmdList);
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

    _setCurrentLine(buffer) {
        this._currentLine.innerText = `${this.cli.getPrompt()} ${buffer.join('')}`;

        if(this._cursor !== 'none') {
            const cursor = document.createElement('span');
            cursor.innerHTML = '&#9608;';
            cursor.classList.add('terminal__cursor');
            cursor.classList.add(this._cursor);
            this._currentLine.appendChild(cursor);
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
            this._working = false;
            if(this._animating) {
                return requestAnimationFrame(this._statusCheck.bind(this, status));
            }
            this._newPrompt(this._setCurrentLine.bind(this, this._buffer));
        } else {
            this._clearCursor();
            this._working = true;
        }
    }

    _attachShellListeners() {
        this.cli.on('status', this._statusCheck.bind(this));

        this.cli.on('stdOut', line => {
            this._print(line, 'out');
        });

        this.cli.on('stdErr', line => {
            this._print(line, 'err');
        });

        this.cli.on('clear', () => {
            this._clearOutput();
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
            if (e.keyCode == 9) {  //tab pressed
                e.preventDefault(); // stops its action
            }
        });

        el.addEventListener('keyup', (e) => this._keyEvent(onUpdate, e.key));
    }

    _keyEvent(onUpdate, key) {
        if (key.length === 1) {
            this._buffer.push(key);

            if (!this._working && !this._animating) {
                onUpdate(this._buffer);
            }
        } else if (key === 'Enter' && !this._working) {
            const command = this._buffer.join('');
            this._buffer = [];
            this.cli.onCommand(command);
        } else if (key === 'Backspace') {
            this._buffer.pop();

            if (!this._working && !this._animating) {
                onUpdate(this._buffer);
            }
        } else if (key === 'Tab' && !this._working && !this._animating) {
            const commandParts = this._buffer.join('').split(' ');
            const lastPath = commandParts.pop();

            const autoComplete = this.cli.tabCompletion(lastPath);
            if(autoComplete) {
                const {options, path} = autoComplete;

                if(options.length === 1) {
                    commandParts.push(`${path ? path.concat('/') : ''}${options[0]}`);
                    this._buffer = commandParts.join(' ').split('');
                } else {
                    this._print(options.join('  '), 'out');
                }

                onUpdate(this._buffer);
            }
        }
    }
}

module.exports = Terminal;

//import css
require('../styles/terminal.css');
'use strict';

const Shell = require('../');

class Terminal {
    constructor(options) {
        const {el, font = 'Roboto Mono'} = options;

        if(!el) {
            throw new Error('you must set `el` option');
        }

        this._working = false;
        this.cli = new Shell(options);
        this._buffer = [];

        this._setupDom(el, font);
        this._attachShellListeners();
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
        this._currentLine = document.createElement('li');
        this._cmdList.appendChild(this._currentLine);
        if(callback) {
            callback();
        }
    }

    _print(data, type = 'out') {
        const line = document.createElement('li');
        line.className = type;
        line.innerText = data;
        this._cmdList.appendChild(line);
    }

    _setCurrentLine(buffer) {
        this._currentLine.innerText = `${this.cli.getPrompt()} ${buffer.join('')}`;
    }

    _attachShellListeners() {
        this.cli.on('status', status => {
            if(status === 'READY') {
                this._working = false;
                this._newPrompt(this._setCurrentLine.bind(this, this._buffer));
            } else {
                this._working = true;
            }
        });

        this.cli.on('stdOut', line => {
            this._print(line, 'out');
        });

        this.cli.on('stdErr', line => {
            this._print(line, 'err');
        });

        this._listenForKeyEvents(this._setCurrentLine.bind(this));
    }

    _listenForKeyEvents(onUpdate) {
        window.addEventListener('keydown', (e) => {
            if (e.key.length === 1) {
                this._buffer.push(e.key);

                if (!this._working) {
                    onUpdate(this._buffer);
                }
            } else if (e.key === 'Enter' && !this._working) {
                const command = this._buffer.join('');
                this._buffer = [];
                this.cli.onCommand(command);
            } else if (e.key === 'Backspace') {
                this._buffer.pop();

                if (!this._working) {
                    onUpdate(this._buffer);
                }
            }
        });
    }
}

module.exports = Terminal;
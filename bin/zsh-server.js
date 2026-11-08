#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3080', 10);
const SHELL_CMD = process.env.SHELL || '/bin/zsh';

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>brsh Terminal — Real zsh PTY</title>
    <link rel="stylesheet" href="/dist/brsh.css">
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            background: #14161b;
            color: #e6e8ee;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-family: 'Roboto Mono', monospace;
        }
        header {
            background: #1f232b;
            border-bottom: 1px solid #2e3440;
            padding: 6px 14px;
            font-size: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            user-select: none;
        }
        header .badge {
            background: #2e7d32;
            color: #fff;
            padding: 2px 8px;
            border-radius: 4px;
            font-weight: bold;
        }
        #terminal {
            flex: 1;
            padding: 8px 10px;
            overflow-y: auto;
            box-sizing: border-box;
        }
    </style>
</head>
<body>
    <header>
        <span id="term-title">brsh/terminal — Connected to ${SHELL_CMD}</span>
        <span class="badge" id="status-badge">LIVE PTY</span>
    </header>
    <div id="terminal"></div>
    <script src="/dist/terminal.min.js"></script>
    <script>
        const ws = new WebSocket(\`ws://\${location.host}/pty\`);
        const statusBadge = document.getElementById('status-badge');
        const titleEl = document.getElementById('term-title');

        ws.addEventListener('open', () => {
            const term = new Terminal({
                el: document.getElementById('terminal'),
                stream: ws,
                cursor: 'blink',
                lineWrap: false
            });

            term.onResize(({ cols, rows }) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(\`\\x1b]9999;\${cols};\${rows}\\x07\`);
                }
            });

            term.onTitleChange((title) => {
                titleEl.textContent = title || 'brsh/terminal';
            });

            // Send initial measured size once ready
            setTimeout(() => {
                term._measureAndSetSize();
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(\`\\x1b]9999;\${term.cols};\${term.rows}\\x07\`);
                }
            }, 100);

            window.term = term;
        });

        ws.addEventListener('close', () => {
            statusBadge.textContent = 'EXITED';
            statusBadge.style.background = '#c62828';
        });
    </script>
</body>
</html>`;

function encodeWsFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x81; // FIN + text frame
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer, onMessage, onClose) {
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const byte0 = buffer[offset];
        const byte1 = buffer[offset + 1];
        const opcode = byte0 & 0x0f;
        const isMasked = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7f;
        let headerLen = 2;

        if (payloadLen === 126) {
            if (offset + 4 > buffer.length) break;
            payloadLen = buffer.readUInt16BE(offset + 2);
            headerLen = 4;
        } else if (payloadLen === 127) {
            if (offset + 10 > buffer.length) break;
            payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
            headerLen = 10;
        }

        const maskLen = isMasked ? 4 : 0;
        const totalFrameLen = headerLen + maskLen + payloadLen;
        if (offset + totalFrameLen > buffer.length) break;

        if (opcode === 0x08) {
            onClose();
            return Buffer.alloc(0);
        }

        if (opcode === 0x01 || opcode === 0x02) {
            const payload = Buffer.alloc(payloadLen);
            const dataStart = offset + headerLen + maskLen;
            if (isMasked) {
                const maskOffset = offset + headerLen;
                for (let i = 0; i < payloadLen; i++) {
                    payload[i] = buffer[dataStart + i] ^ buffer[maskOffset + (i & 3)];
                }
            } else {
                buffer.copy(payload, 0, dataStart, dataStart + payloadLen);
            }
            onMessage(payload.toString('utf8'));
        }

        offset += totalFrameLen;
    }
    return buffer.slice(offset);
}

async function startServer() {
    const { spawnPty } = await import('../lib/terminal/PtyBridge.js');

    const server = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HTML_PAGE);
            return;
        }

        if (req.url.startsWith('/dist/')) {
            const safeName = path.basename(req.url);
            const filePath = path.join(__dirname, '..', 'dist', safeName);
            if (fs.existsSync(filePath)) {
                const ext = path.extname(safeName);
                const mime = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
                res.writeHead(200, { 'Content-Type': mime });
                res.end(fs.readFileSync(filePath));
                return;
            }
        }

        res.writeHead(404);
        res.end('Not found');
    });

    server.on('upgrade', (req, socket) => {
        if (req.url !== '/pty') {
            socket.destroy();
            return;
        }

        const key = req.headers['sec-websocket-key'];
        const accept = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');

        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );

        const pty = spawnPty(SHELL_CMD, ['-i'], {
            cols: 80,
            rows: 24,
            cwd: process.cwd()
        });

        pty.on('data', (chunk) => {
            if (!socket.destroyed) {
                const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
                socket.write(encodeWsFrame(str));
            }
        });

        pty.on('exit', () => {
            if (!socket.destroyed) {
                socket.end(Buffer.from([0x88, 0x00]));
            }
        });

        let rxBuffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            rxBuffer = Buffer.concat([rxBuffer, chunk]);
            rxBuffer = decodeWsFrames(
                rxBuffer,
                (msg) => pty.write(msg),
                () => {
                    pty.kill();
                    socket.end();
                }
            );
        });

        socket.on('close', () => pty.kill());
        socket.on('error', () => pty.kill());
    });

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`zsh terminal server listening on http://127.0.0.1:${PORT}`);
    });
}

startServer();

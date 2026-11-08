'use strict';

const PY_PTY_BRIDGE = `
import os, sys, pty, select, fcntl, termios, struct, signal, json

cmd = sys.argv[1]
args = json.loads(sys.argv[2])
cols = int(sys.argv[3])
rows = int(sys.argv[4])
cwd = sys.argv[5]

pid, fd = pty.fork()
if pid == 0:
    if cwd:
        try: os.chdir(cwd)
        except Exception: pass
    os.execvp(cmd, [cmd] + args)

def set_winsize(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass

set_winsize(cols, rows)
stdin_fd = sys.stdin.fileno()
stdout_fd = sys.stdout.fileno()

try:
    while True:
        rlist, _, _ = select.select([fd, stdin_fd], [], [])
        if fd in rlist:
            try:
                data = os.read(fd, 8192)
                if not data:
                    break
                os.write(stdout_fd, data)
            except OSError:
                break
        if stdin_fd in rlist:
            try:
                chunk = os.read(stdin_fd, 8192)
                if not chunk:
                    break
                # Check for inline resize control packet: \\x1b]9999;cols;rows\\x07
                while b"\\x1b]9999;" in chunk:
                    start = chunk.find(b"\\x1b]9999;")
                    end = chunk.find(b"\\x07", start)
                    if end == -1:
                        break
                    packet = chunk[start+7:end].decode("ascii", "ignore")
                    parts = packet.split(";")
                    if len(parts) == 2:
                        set_winsize(int(parts[0]), int(parts[1]))
                    chunk = chunk[:start] + chunk[end+1:]
                if chunk:
                    os.write(fd, chunk)
            except OSError:
                break
finally:
    try:
        os.close(fd)
    except Exception:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
    except Exception:
        sys.exit(0)
`;

function getDefaultShell(req) {
    if (typeof process !== 'undefined' && process.env && process.env.SHELL) {
        return process.env.SHELL;
    }
    try {
        const fs = req ? req('fs') : null;
        if (fs) {
            for (const candidate of ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']) {
                if (fs.existsSync(candidate)) return candidate;
            }
        }
    } catch (_) {}
    return '/bin/sh';
}

export function spawnPty(command, args = [], options = {}) {
    // Dynamic require so browser bundles don't fail trying to bundle child_process
    const req = typeof require === 'function'
        ? require
        : (typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.getBuiltinModule
            ? (m) => globalThis.process.getBuiltinModule(m)
            : null);

    if (!req) {
        throw new Error('spawnPty is only available in a Node.js environment');
    }

    const shellCmd = command || getDefaultShell(req);
    const { spawn } = req('child_process');
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const cwd = options.cwd || (typeof process !== 'undefined' ? process.cwd() : '');
    const env = Object.assign(
        {},
        typeof process !== 'undefined' ? process.env : {},
        {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            COLUMNS: String(cols),
            LINES: String(rows)
        },
        options.env || {}
    );

    const child = spawn(
        'python3',
        ['-u', '-c', PY_PTY_BRIDGE, shellCmd, JSON.stringify(args), String(cols), String(rows), cwd],
        {
            env,
            stdio: ['pipe', 'pipe', 'pipe']
        }
    );

    const listeners = new Map();
    const emit = (ev, ...a) => {
        const list = listeners.get(ev);
        if (!list) return;
        for (const fn of [...list]) fn(...a);
    };

    child.stdout.on('data', (chunk) => emit('data', chunk));
    child.on('exit', (code, signal) => emit('exit', code, signal));
    child.on('close', (code) => emit('close', code));
    child.on('error', (err) => emit('error', err));

    return {
        pid: child.pid,
        process: child,
        write(data) {
            if (child.stdin && !child.stdin.destroyed) {
                child.stdin.write(data);
            }
        },
        resize(c, r) {
            if (child.stdin && !child.stdin.destroyed) {
                child.stdin.write(`\x1b]9999;${Math.max(1, c)};${Math.max(1, r)}\x07`);
            }
        },
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
            return this;
        },
        removeListener(event, fn) {
            const list = listeners.get(event);
            if (!list) return this;
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
            return this;
        },
        kill(sig = 'SIGTERM') {
            try { child.kill(sig); } catch (e) { /* ignore */ }
        }
    };
}

export default spawnPty;

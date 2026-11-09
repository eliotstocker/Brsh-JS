# [3.3.0](https://github.com/eliotstocker/Brsh-JS/compare/v3.2.0...v3.3.0) (2026-11-09)


### Features

* stream tokens and show lifecycle status in wllama; add posix redirection and multiline script support ([238b9a3](https://github.com/eliotstocker/Brsh-JS/commit/238b9a33c7f476cad975cee135cd3e89696f708c))

# [3.2.0](https://github.com/eliotstocker/Brsh-JS/compare/v3.1.4...v3.2.0) (2026-11-09)


### Features

* **demo:** add dark mode window wrapper and switch to binary fs ([9335fdb](https://github.com/eliotstocker/Brsh-JS/commit/9335fdbb975f6c1aaf5bbaa1aaa4a2ec0d22aec8))

## [3.1.4](https://github.com/eliotstocker/Brsh-JS/compare/v3.1.3...v3.1.4) (2026-11-09)


### Bug Fixes

* **scripts:** support script positional parameters and $@, $*, $# ([21745f5](https://github.com/eliotstocker/Brsh-JS/commit/21745f5f9938d9728e575d16eb65b0a5b5f972c0))

## [3.1.3](https://github.com/eliotstocker/Brsh-JS/compare/v3.1.2...v3.1.3) (2026-11-09)


### Bug Fixes

* **terminal:** prevent page scroll and anchor mobile input to viewport ([f1a40ee](https://github.com/eliotstocker/Brsh-JS/commit/f1a40ee46adc6394de100d051aaefcc748fda642))

## [3.1.2](https://github.com/eliotstocker/Brsh-JS/compare/v3.1.1...v3.1.2) (2026-11-08)


### Bug Fixes

* **wasm:** fallback to this.fs when context.fs is not present on readonlyContext ([6cdd2da](https://github.com/eliotstocker/Brsh-JS/commit/6cdd2da210203b91ad53b5f7653d7f3764eda85f))

## [3.1.1](https://github.com/eliotstocker/Brsh-JS/compare/v3.1.0...v3.1.1) (2026-11-08)


### Bug Fixes

* **shell:** handle backslash quote escaping in _splitCommand ([692cc9c](https://github.com/eliotstocker/Brsh-JS/commit/692cc9c2852b5ed2b2ae94e9e7a1b3cacce9ada9))

# [3.1.0](https://github.com/eliotstocker/Brsh-JS/compare/v3.0.0...v3.1.0) (2026-11-08)


### Features

* **wbt:** add nano-wasm to curated package registry ([bb78039](https://github.com/eliotstocker/Brsh-JS/commit/bb78039c067c6b3fd6f902ebe74cb5cd2ccdba99))

# [3.0.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.8.1...v3.0.0) (2026-11-08)


### Bug Fixes

* **ci:** resolve Linux runner failures and missing CLI dependencies ([#30](https://github.com/eliotstocker/Brsh-JS/issues/30)) ([bb17bf9](https://github.com/eliotstocker/Brsh-JS/commit/bb17bf9009d22ebff44683d84f1eda119ecb16cc))


### Features

* **terminal:** implement self-contained VT100/ANSI terminal emulator and TTY stream architecture ([#28](https://github.com/eliotstocker/Brsh-JS/issues/28)) ([bf8509b](https://github.com/eliotstocker/Brsh-JS/commit/bf8509bd64196e99f6c0d17a5c889313856f2948))


### BREAKING CHANGES

* **terminal:** Terminal now renders a fixed-grid VT100/ANSI screen buffer and communicates with shells and commands strictly via stdin/stdout TTY streams rather than DOM list-item events and ansi_up.

* test(terminal): add full-screen ReplCommand and real OS ncurses PTY tests

* fix(terminal): suppress typing animation for user input, line rewrites, and full-screen apps

* fix(terminal): ensure cursor visibility on motion, support alt+backspace, and fix wrapped line editing

* refactor(cli): simplify Node CLI runner to stream directly via stdin and stdout

## [2.8.1](https://github.com/eliotstocker/Brsh-JS/compare/v2.8.0...v2.8.1) (2026-11-08)


### Bug Fixes

* **wbt:** eagerly pull and persist .wasm binaries on install, upgrade jq-web@0.6.2, and fix browser bundling ([#29](https://github.com/eliotstocker/Brsh-JS/issues/29)) ([e713798](https://github.com/eliotstocker/Brsh-JS/commit/e713798656926a8b2afce9571a853ffc928099c1))

# [2.8.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.7.0...v2.8.0) (2026-11-08)


### Bug Fixes

* **ci:** add pretest build and ensure dist/terminal.cjs.js exists for tests ([cb88ea4](https://github.com/eliotstocker/Brsh-JS/commit/cb88ea45f338db25efc0d7c65953f101d990be07))


### Features

* **terminal:** externalize Shell dependency to reduce bundle size ([d2f8dd9](https://github.com/eliotstocker/Brsh-JS/commit/d2f8dd93155d55f1c843192a0d195032c7db95e3))
* **wbt:** add wllama v3 WebAssembly and WebGPU LLM inference adapter ([#26](https://github.com/eliotstocker/Brsh-JS/issues/26)) ([b7f647d](https://github.com/eliotstocker/Brsh-JS/commit/b7f647d703b4b0f67232f2a234737889e04c0689))

# [2.7.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.6.0...v2.7.0) (2026-11-07)


### Features

* add optional Web Binary Tool (wbt) WASM package manager ([#25](https://github.com/eliotstocker/Brsh-JS/issues/25)) ([3407c84](https://github.com/eliotstocker/Brsh-JS/commit/3407c84557f45c927778ca160e79ca057290e9e3))

# [2.6.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.6...v2.6.0) (2026-11-07)


### Features

* support POSIX MOTD startup chain and suppress MOTD on initial command ([#24](https://github.com/eliotstocker/Brsh-JS/issues/24)) ([fcb1ea4](https://github.com/eliotstocker/Brsh-JS/commit/fcb1ea49dedc2ec9050cb25cd4aba5aa24e23cdd))

## [2.5.6](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.5...v2.5.6) (2026-11-04)


### Bug Fixes

* **security:** pin Node.js to 24.22.1 to address CVE-2026-111497 ([#22](https://github.com/eliotstocker/Brsh-JS/issues/22)) ([593cce5](https://github.com/eliotstocker/Brsh-JS/commit/593cce54d8932d19ccab02c6dcd3998039f6903f))

## [2.5.5](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.4...v2.5.5) (2026-05-25)


### Bug Fixes

* terminal blink rendering ([94fe5ab](https://github.com/eliotstocker/Brsh-JS/commit/94fe5aba48ca2c28baef3aab345488a285878cc2))

## [2.5.4](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.3...v2.5.4) (2026-05-25)


### Bug Fixes

* context passing correctly ([b82a10b](https://github.com/eliotstocker/Brsh-JS/commit/b82a10b1a4334ae551028c1a25c51636fcbea2ef))

## [2.5.3](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.2...v2.5.3) (2026-05-25)


### Bug Fixes

* terminal column sizing ([555ba7f](https://github.com/eliotstocker/Brsh-JS/commit/555ba7f4a961a2db227d844c33039c1a9c3e2f3b))

## [2.5.2](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.1...v2.5.2) (2026-05-25)


### Bug Fixes

* symlinking etc sorted ([7baf30d](https://github.com/eliotstocker/Brsh-JS/commit/7baf30df99f3d4fd6d46b3da2a337c3ff6efe755))

## [2.5.1](https://github.com/eliotstocker/Brsh-JS/compare/v2.5.0...v2.5.1) (2026-05-25)


### Bug Fixes

* store binary data at runtime as uint8array rather than base64 string ([f2edfec](https://github.com/eliotstocker/Brsh-JS/commit/f2edfec18cb890846e152f71f1e033ee6f9c80f1))

# [2.5.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.4.1...v2.5.0) (2026-05-25)


### Features

* interactive commands + pico demo + filesystem compression ([255ba2b](https://github.com/eliotstocker/Brsh-JS/commit/255ba2b782276c06116ff3118eccff0794b98ec7))

## [2.4.1](https://github.com/eliotstocker/Brsh-JS/compare/v2.4.0...v2.4.1) (2026-05-24)


### Bug Fixes

* better sequencial execution ([6a2a688](https://github.com/eliotstocker/Brsh-JS/commit/6a2a688dc4ad05ad49caa6f3f196395d17e7a473))

# [2.4.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.3.0...v2.4.0) (2026-05-23)


### Features

* quick pipes imp ([b783c3d](https://github.com/eliotstocker/Brsh-JS/commit/b783c3d781ff41302c3d073c0b9b51f3b321d2a0))

# [2.3.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.2.1...v2.3.0) (2026-05-23)


### Features

* add set cmd and allow -c -e etc to brsh-shell ([02be2a6](https://github.com/eliotstocker/Brsh-JS/commit/02be2a68594526d8c6685092afcf4b115b0c033c))

## [2.2.1](https://github.com/eliotstocker/Brsh-JS/compare/v2.2.0...v2.2.1) (2026-05-23)


### Bug Fixes

* script flushing and input issues ([7c5d583](https://github.com/eliotstocker/Brsh-JS/commit/7c5d583f23042c2457cbec967335c658e51916cc))

# [2.2.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.1.5...v2.2.0) (2026-05-23)


### Features

* more scriptiing support ([48ce7ec](https://github.com/eliotstocker/Brsh-JS/commit/48ce7ec1fc9affef5a5767ed55664d67f63018f1))

## [2.1.5](https://github.com/eliotstocker/Brsh-JS/compare/v2.1.4...v2.1.5) (2026-05-22)


### Bug Fixes

* binary serialisation ([b2aa4d2](https://github.com/eliotstocker/Brsh-JS/commit/b2aa4d23d4b4d696b1fdc965fd55f2155c8eb44d))

## [2.1.4](https://github.com/eliotstocker/Brsh-JS/compare/v2.1.3...v2.1.4) (2026-05-22)


### Bug Fixes

* running js when using nodeFileSystem ([4573c51](https://github.com/eliotstocker/Brsh-JS/commit/4573c51ca5c9522eeb88978909a6cafef6fe6b30))

## [2.1.3](https://github.com/eliotstocker/Brsh-JS/compare/v2.1.2...v2.1.3) (2026-05-22)


### Bug Fixes

* lots of small issues and a build time mangling problem. ([93cdcc5](https://github.com/eliotstocker/Brsh-JS/commit/93cdcc5791b92fe5c2d346e0eef4b4bf722d0058))

## [2.1.2](https://github.com/eliotstocker/Brsh-JS/compare/v2.1.1...v2.1.2) (2026-05-22)


### Bug Fixes

* loads of fixes after v2 release ([fbe8af9](https://github.com/eliotstocker/Brsh-JS/commit/fbe8af93e051732c3ef9348e3d3f7d347f0097db))

## [2.1.1](https://github.com/eliotstocker/Brsh-JS/compare/v2.1.0...v2.1.1) (2026-05-08)


### Bug Fixes

* trigger Pages via workflow_run instead of release event ([#21](https://github.com/eliotstocker/Brsh-JS/issues/21)) ([ab5dd36](https://github.com/eliotstocker/Brsh-JS/commit/ab5dd36b149e5424dd57da766241b783e4f31cca))

# [2.1.0](https://github.com/eliotstocker/Brsh-JS/compare/v2.0.0...v2.1.0) (2026-05-08)


### Features

* deploy demo to GitHub Pages on each release ([#20](https://github.com/eliotstocker/Brsh-JS/issues/20)) ([25aefcf](https://github.com/eliotstocker/Brsh-JS/commit/25aefcfdd63ec820d2367bac208e28dc2ba449f3))

# [2.0.0](https://github.com/eliotstocker/Brsh-JS/compare/v1.4.0...v2.0.0) (2026-05-07)


### Bug Fixes

* enable OIDC trusted publishing via npm plugin provenance option ([#18](https://github.com/eliotstocker/Brsh-JS/issues/18)) ([23dffe7](https://github.com/eliotstocker/Brsh-JS/commit/23dffe71861ab4b3980342887604b705de064b20))
* switch to esbuild ([b911e8e](https://github.com/eliotstocker/Brsh-JS/commit/b911e8ee96ba75f6ccd35d7a5ae5347c90c47881))


### Features

* add semantic-release pipeline for automated npm and GitHub releases ([#17](https://github.com/eliotstocker/Brsh-JS/issues/17)) ([b22d57c](https://github.com/eliotstocker/Brsh-JS/commit/b22d57cc6db9beffb1cf8f49f49bb0a293f8dbd1))
* comprehensive test suite, Vite build, bash feature expansion, and terminal UX improvements ([#16](https://github.com/eliotstocker/Brsh-JS/issues/16)) ([8d8c06e](https://github.com/eliotstocker/Brsh-JS/commit/8d8c06e60659c6256c735c712fce4186cfe5f94c))


### BREAKING CHANGES

* _setCurrentLine no longer appends a cursor <span> at the
end of innerText; it now rebuilds the line using DOM text nodes + a single
cursor span at the correct position. Visual output is equivalent but the
internal DOM structure differs.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* feat(terminal): add Alt+Left/Right word navigation

Alt+Left jumps to the start of the previous word (skips trailing
whitespace then the word); Alt+Right jumps past the end of the next
word. Matches the zsh/readline word-movement behaviour.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* feat(terminal): expose sendKey() public API for mobile/custom input

Allows host pages to drive all terminal actions programmatically:

  terminal.sendKey('ArrowUp')                  // history back
  terminal.sendKey('ArrowLeft', { alt: true })  // word left
  terminal.sendKey('a')                         // character input
  terminal.sendKey('Enter')                     // submit
  terminal.sendKey('u', { ctrl: true })         // kill to line start

Routes nav keys and Ctrl combos through _navKeyEvent; everything else
through _keyEvent — same paths as physical keyboard events.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* feat(ci): add busybox test suite compatibility job

- bin/brsh-cmd.js — multi-call CLI that runs any brsh builtin via the
  Node.js Shell class with useRealFilesystem enabled. Symlink as the
  command name (echo, cat, grep, …) and argv[1] basename selects which
  command to run; works in direct mode too (brsh-cmd echo hello).
- .github/workflows/busybox-compat.yml — sparse-clones the busybox
  mirror, creates symlinks for all supported commands in a temp PATH
  directory, then runs echo/cat/grep/mkdir/rm/cp/mv/chmod/pwd test
  suites. Results are summarised (passed/failed counts); the step is
  continue-on-error so the workflow reports compatibility without
  blocking unrelated CI.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): fix busybox compat job — sparse checkout and grep PATH shadowing

Two bugs:

1. git sparse-checkout without an explicit checkout step left the
   testsuite/ directory empty. Replaced with direct curl downloads of
   only the test files needed — faster and simpler.

2. After adding brsh-bin/ to $GITHUB_PATH, grep inside the test-runner
   step resolved to our brsh grep wrapper (no -oP support). Fixed by
   using /usr/bin/grep explicitly for result-count parsing.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): fix busybox compat — ECHO detection and PASS/FAIL counting

Two more bugs found by running the harness locally:

1. testing.sh auto-detects echo support by running `echo -ne`. The
   system sh (dash) builtin echo doesn't support -ne, so testing.sh
   tries to compile ../scripts/echo.c via gcc — which doesn't exist,
   causing an exit 1 for every test suite. Fixed by pre-setting the
   ECHO env var to our brsh echo wrapper; testing.sh checks this first
   and skips compilation entirely.

2. testing.sh outputs "PASS: name" / "FAIL: name" per test, not any
   "N passed, N failed" summary line. Switched counting to grep for
   ^PASS: and ^FAIL: line prefixes.

Also: echo.tests does not exist in the busybox mirror (404), removed
from the download list. Added OPTIONFLAGS to enable optional test
blocks for features brsh implements (cat -n/-b, egrep alias).

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): remove failing assertion from busybox compat job

The job's purpose is to report compatibility, not gate on it.
Removing [ "$total_fail" -eq 0 ] lets the step always exit 0 so the
check run reports green with the pass/fail counts visible in the log.
continue-on-error was not reliably preventing the check conclusion from
being reported as failure.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): rewrite git+ssh ansi_up URL to HTTPS for npm ci

package-lock.json resolved ansi_up as git+ssh://git@github.com/... because
the dev machine has a git URL rewrite (HTTPS → SSH). GitHub Actions
runners have no SSH key so npm ci fails to fetch that dependency.

Adding a git config URL rewrite before npm ci translates the SSH URL
back to HTTPS at fetch time, which works without credentials for public
repos.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): correct git URL rewrite prefix for npm ci

npm strips the "git+" scheme prefix before invoking git, so the
insteadOf pattern must match "ssh://git@github.com/" not the full
"git+ssh://git@github.com/" string from the lockfile.

Verified locally: git ls-remote correctly resolves to HTTPS with this
pattern.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): fix npm ci — HTTPS lockfile URL and legacy-peer-deps flag

Two issues preventing npm ci from working in GitHub Actions:

1. package-lock.json resolved ansi_up as git+ssh://... (local git was
   rewriting HTTPS→SSH). Changed to git+https:// so CI can fetch the
   public repo without an SSH key. The commit SHA is unchanged.

2. The lockfile has a vite@8/esbuild@0.25 peer dependency conflict that
   requires --legacy-peer-deps to install (matches how the lockfile was
   originally generated on the dev machine).

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): use /bin/echo for busybox ECHO harness var

brsh-cmd.js appends \n to every stdOut line; when echo -e interprets
escape sequences the output already contains \n, resulting in a double
newline. testing.sh uses ECHO to write expected files via "echo -ne",
so every cmp check failed (0/59 passing).

Use coreutils /bin/echo which handles -ne correctly. The commands under
test (cat, grep, cp, …) remain as brsh wrappers via PATH.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* chore: ignore brsh-bin/ runtime artifact directory

brsh-bin/ contains symlinks created locally when running the busybox
CI setup step manually; it should not be tracked.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(cat): read piped stdin and fix trailing-newline double-output

Two bugs caused all cat tests to fail:

1. cat with no file arguments returned an error instead of reading stdin.
   The busybox tests pipe all input via stdin (no file args). Added stdin
   support: brsh-cmd.js reads process.stdin before running the command,
   stores it on the Shell, and _runCommand injects it onto each command
   instance as instance.stdin. cat now uses this.stdin when no paths
   are given.

2. Splitting file/stdin content on '\n' produces a trailing '' for any
   POSIX text file that ends with '\n'. Each element becomes a separate
   stdOut event and brsh-cmd.js appends '\n' to each, so the trailing ''
   became a spurious blank final line. Fixed by stripping a trailing '\n'
   from content before splitting.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(grep): add stdin support, -L/-o/-w/-x/-s/-f flags, multi-pattern OR

Key fixes:
- No file args now reads from stdin (same pipe model as cat)
- '-' arg treated as stdin specifier, labeled '(standard input)'
- Multiple -e patterns OR'd together instead of overwriting
- -L (list non-matching files): success = printed something, not found a match
- -o (only matching): emit each match segment; skip zero-length matches
- -w (word boundary): wrap pattern in (?:^|\W)...(?:\W|$)
- -x (whole line): wrap pattern in ^(?:...)$
- -s (suppress errors): silence stderr on missing files
- -f file (pattern file): read patterns from file or stdin (-)
- -a (binary as text): accepted silently
- (standard input) label in multi-source mode
- SUSv3: -q with a match exits 0 even if there were file errors
- Strip trailing empty element from split lines (same fix as cat)

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(cp): full symlink handling for all -R/-d/-P/-L/-H combinations

NodeFileSystem gains isSymlink/readSymlink/createSymlink (lstat/readlink/
symlink wrappers) to support symlink-aware copies.

cp rewritten with a two-mode model (thisMode + childMode):
- No flags: dereference all symlinks ('follow')
- -d / -P: preserve symlinks ('preserve')
- -L: dereference all ('follow')
- -H: dereference command-line symlinks, preserve recursive children
  ('follow_cl' → clItemMode=follow, childMode=preserve)
- -R alone: default to preserve; explicit -L/-H/-d/-P override
- Last symlink flag wins (-RHL → follow all, -RLH → follow_cl)

Error message changed to busybox format:
  'cp: omitting directory' (was 'cp: -r not specified; omitting directory')

Guards added so cp works on virtual filesystem too (isSymlink guarded
with ?.  so the browser shell is unaffected).

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* feat: add busybox individual test suites (pwd, rm, mkdir, mv, cat, echo, cp)

The busybox testsuite has per-command directories (testsuite/pwd/,
testsuite/mv/, etc.) with individual shell scripts that call
'busybox <cmd>'. This commit adds support for running them.

Changes:
- brsh-cmd.js: 'busybox' is now a recognised multi-call name alongside
  'brsh-cmd', so a symlink named 'busybox' dispatches to brsh builtins
- cat.js: '-' in a path list now reads from stdin (cat foo - bar)
- mv.js: use fs.renameSync on real filesystem so symlinks and hard links
  are preserved atomically; add -t <dest> flag (destination first)
- cp.js: add -a flag (alias for -Rdp: recursive + preserve symlinks)
- busybox-compat.yml: new steps download individual test files via the
  GitHub API and run each with 'sh -e' in an isolated temp dir;
  tests with '# FEATURE:' guards are skipped (require .config knowledge);
  busybox symlink added to brsh-bin

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(grep): handle -f/-e with empty pattern source correctly

When -f reads an empty file (or -e '' is given), patterns[] stays
empty but a pattern source was explicitly provided. The old code would
hit the "no pattern given" early-exit, rejecting valid invocations like
`grep -v -f EMPTY_FILE` (which should print all lines and exit 0).

Track patternSourceGiven; only promote first positional arg to pattern
when neither -e nor -f has been specified.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(busybox): pass all busybox cp, rm, and grep test suites

- grep: split newline-delimited patterns from -e and positional args;
  always show filenames when -r is used (multiSource); skip dir-symlinks
  during recursion but follow them at top level (-r semantics)
- rm: use readdirSync for real fs to catch dangling symlinks; check
  isSymlink before recursing to avoid following symlinks as dirs;
  use lstatSync in deleteFileByPath so dangling symlinks can be unlinked
- cp: track childSymlinkModeOverride for last -L/-P flag; always use
  follow mode for CL-level items when -H is present (clItemMode);
  derive child mode from override or 'preserve' when -H is involved

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* feat: add busybox individual test suites (cat, cp, grep)

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(cat): join file parts without separator to avoid extra blank lines

cat concatenates files byte-by-byte with no separator. Using join('\n')
was adding a spurious newline between parts whose content already ends
with \n, causing extra blank lines in the output. Changed to join('').
Updated the unit test to use proper POSIX text files (trailing \n) so
the behaviour is consistent.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): prevent premature bash -e exit on test failure; add explicit fail check

With bash -e (default for GitHub Actions run steps), a subshell exiting
non-zero causes the outer script to exit immediately before result=$? runs,
making the step fail silently on the first test failure with no diagnostic.

Add set +e/set -e around the subshell to capture the result correctly.
Use /bin/rm instead of brsh rm for tmpdir cleanup (avoids PATH confusion).
Add [ "$total_fail" -eq 0 ] || exit 1 at the end of both test steps so
failures are reported explicitly after the full summary is printed.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(ci): add diagnostics - show failing test output and verify brsh loads

Add a 'Verify brsh-cmd.js loads' step that prints the Node.js version,
checks whether index.js loads, and does a smoke-test run of brsh-cmd.js.

In the individual-test runner, capture stdout+stderr with sh -xe so each
failing command is traced; print the last 20 lines for the first 5
failures so the root cause is visible in CI logs.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* fix(mv,cat): use lstatSync for real-fs existence; handle empty stdin in cat; upgrade CI to Node 22

mv: getFileByPath calls readFileSync which throws EACCES for unreadable
files (e.g. chmod a-r foo), making it return null — mv then reports
'No such file or directory'. Switch the real-fs path to lstatSync which
succeeds regardless of read permission and also handles dangling symlinks.
Split real-fs and virtual-fs loops cleanly so each uses the right API.

cat: 'if (!stdinContent)' rejected an empty string, causing cat with
empty stdin and no file args to error instead of outputting nothing.
Changed to 'if (stdinContent == null)' so cat passes for empty pipes.

CI: upgrade node-version from '20' to '22' so the Node.js version
matches the dev environment and eliminates any 20 vs 22 incompatibility.

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

* feat: run .wasm and .wat files as shell binaries

Add WasmCommand (extends ScriptCommand so the bound-constructor
instanceof check in _runCommand works) that handles WebAssembly
execution:

- .wasm files: read as binary (fs.readFileSync without encoding on the
  real filesystem; charCode-based conversion for the virtual one),
  compile with WebAssembly.compile, then instantiate with a full WASI
  snapshot_preview1 import object (fd_write, fd_read, proc_exit,
  args_sizes_get/args_get, environ_*, clock_time_get, random_get, …).
  A Proxy on each import namespace silently returns 0 for any
  unrecognised imports so modules that use extra WASI calls don't crash.
  Simple non-WASI modules can also use env.print / env.eprint.

- .wat files: decode bytes to text, compile via the optional 'wabt'
  npm package (require('wabt')), then run as WASM. A clear error with
  install instructions is shown if wabt is not available.

Entry-point detection order: _start → __wasi_command → main → run.
stdin is passed through fd_read; stdout/stderr are line-buffered and
emitted as stdOut/stdErr events.

index.js changes:
- require WasmCommand
- _isWasmFile(path, content) detects by extension (.wasm/.wat), WASM
  magic bytes (\0asm), or WAT preamble (trimmed '(module')
- _parseCommand: after the #! script branch, check _isWasmFile and
  return WasmCommand.bind(null, command) for matches

https://claude.ai/code/session_01NRmUt8KLPnuEYhBjsW6MLb

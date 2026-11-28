# POSIX Shell Compatibility Checklist

Track progress toward a POSIX-compliant `sh` implementation in Brsh-JS.

---

## Shell Syntax & Built-in Behaviour

### Operators / Redirection
- [x] Pipes (`|`) — `cmd1 | cmd2`
- [x] Negation operator (`!`) — `! cmd` / `! pipeline`
- [x] Logical AND (`&&`)
- [x] Logical OR (`||`)
- [x] Sequential (`;`)
- [x] Output redirect (`>`, `>>`)
- [x] Stream & file descriptor redirect (`2>&1`, `2>`, `1>`, `&>`)
- [x] Line continuation (`\`) and multiline quotes (`'`, `"`) in scripts
- [ ] Input redirect (`<`)
- [ ] Here-doc (`<<EOF … EOF`)
- [ ] Here-string (`<<<`)
- [ ] Process substitution (`<(cmd)`, `>(cmd)`) *(non-POSIX but common)*

### Control Flow
- [x] `if` / `elif` / `else` / `fi`
- [x] `while` / `do` / `done`
- [x] `for var in list; do … done`
- [x] `case … in … esac`
- [x] `break [n]` — exit loop
- [x] `continue [n]` — next iteration
- [ ] Subshell `( cmds )`

### Functions
- [x] `name() { … }` definition
- [x] `function name { … }` definition
- [x] `return [n]`
- [x] Positional parameters (`$1`, `$2`, … inside function)
- [x] `local var` — function-scoped variables *(`local X`, `local X=v`, several names; dynamic scope, restored on return, per-call in recursion; error outside a function)*

### Variable Expansion
- [x] `$VAR` / `${VAR}`
- [x] `$?` — last exit code
- [x] `$#` — positional parameter count
- [x] `$1` … `$n` — positional parameters
- [x] `$@` — all positional params as separate words *(`"$@"` in scripts, functions and `for` lists; expands to nothing with no args)*
- [x] `$*` — all positional params joined into one word *(unquoted form tested; `"$*"` not separately verified)*
- [ ] `$0` — script / shell name
- [ ] `$$` — current PID *(can be faked)*
- [x] `${var:-default}` — use default if unset/empty *(defaults may contain quotes, `$VAR` and `$(...)`; the colon-less `${var-default}` forms behave identically since empty variables are stored as unset)*
- [x] `${var:=default}` — assign default if unset/empty
- [x] `${var:?error}` — error if unset/empty *(fails the command; does not yet exit a non-interactive shell)*
- [x] `${var:+alt}` — use alt if set
- [x] `${#var}` — string length
- [ ] `${var#pattern}` — strip shortest prefix
- [ ] `${var##pattern}` — strip longest prefix
- [ ] `${var%pattern}` — strip shortest suffix
- [ ] `${var%%pattern}` — strip longest suffix
- [ ] `${var/from/to}` — replace first *(non-POSIX but common)*
- [ ] `${var//from/to}` — replace all *(non-POSIX but common)*

### Expansion
- [x] Command substitution `$(cmd)` (nested quotes, parens and `;` `&&` `||` `|` inside are respected; output is never re-expanded)
- [x] Single quotes and `\$` keep `$` literal
- [x] Arithmetic expansion `$((expr))` (both `$VAR` and bare `VAR` forms)
- [ ] Tilde expansion (`~`, `~user`)
- [ ] Filename glob expansion (`*`, `?`, `[a-z]`)
- [ ] Brace expansion `{a,b,c}` *(non-POSIX but common)*

### Special Built-ins (POSIX required)
- [x] `exit [n]`
- [x] `export VAR=val`
- [x] `return [n]`
- [x] `set` (flags + positional params)
- [x] `source` / `. script`
- [x] `.` — dot command (alias for `source`)
- [x] `:` — no-op, always exits 0 *(arguments are still expanded, so `: ${VAR:=default}` works)*
- [x] `break [n]`
- [x] `continue [n]`
- [x] `shift [n]` *(updates `$1`…, `$#`, `$@`, `$*`; scoped to the function when used inside one; errors when out of range)*
- [x] `unset var` *(`-v` and several names; `-f` for functions not supported)*
- [ ] `readonly var`
- [ ] `eval string`
- [ ] `exec [cmd]`
- [ ] `trap cmd sig`
- [ ] `times`
- [ ] `wait [pid]`
- [ ] `getopts optstring var`

### Other Shell Features
- [x] `set -e` (errexit)
- [x] `set -x` (xtrace)
- [ ] `set -u` (nounset — flag stored but not enforced)
- [ ] `set -n` (noexec — flag stored but not enforced)
- [ ] `set -o pipefail` *(non-POSIX but common)*

---

## Commands / Utilities

### Text Processing
- [x] `echo`
- [x] `printf`
- [x] `cat`
- [x] `grep`
- [ ] `wc`
- [ ] `head`
- [x] `tail` *(`-n`, `-c`, `+N`, legacy `-N`, multiple files, stdin; `-f` ignored)*
- [ ] `sort`
- [ ] `uniq`
- [ ] `tr`
- [ ] `cut`
- [ ] `tee` *(requires pipe support)*
- [x] `sed` *(s with g/p/i/N flags, d, p, q, y, `=`, line/`$`/regex addresses, ranges, `!`, `-n`, `-e`, `-E`/`-r`, BRE by default; no a/i/c, `{}` blocks, hold space, `-f` or `-i`)*
- [ ] `awk`

### Filesystem
- [x] `ls`
- [x] `cp`
- [x] `mv`
- [x] `rm`
- [x] `mkdir`
- [x] `chmod`
- [x] `cd` / `pwd`
- [x] `touch`
- [ ] `find`
- [x] `ln` (`-s` symlinks on virtual & real FS, hard links on real FS, `-f` force)
- [x] `stat` (real FS: full lstat output; virtual FS: size, type, mode)

### Path Utilities
- [ ] `basename`
- [ ] `dirname`
- [ ] `realpath` *(non-POSIX but common)*

### System / Misc
- [ ] `date`
- [ ] `sleep`
- [ ] `env` / `printenv`
- [ ] `kill`
- [ ] `xargs`
- [x] `test` / `[` (standalone `test` and `[` builtins)
- [x] `which`
- [x] `true`
- [x] `false`
- [x] `read` (`-r`, backslash escapes and line continuation, multiple names, `IFS` splitting, `-n`, `-p`, `-t`; escaped separators still split, empty `IFS` unreachable from the shell)
- [x] `alias`
- [x] `exit`

---

## Priority Order

1. **Input redirect (`<`)** — needed for many real scripts
2. **`eval` / `readonly` / `trap` / `exec`** — remaining special builtins
3. **`$0`** — script / shell name (currently expands to empty in scripts)
4. **`${var#pat}` / `${var%pat}` pattern removal** — the remaining common parameter expansion forms
5. **`wc`, `head`, `sort`, `uniq`, `tr`, `cut`** — most-used text utilities
6. **`basename` / `dirname`** — common path helpers
7. **`unset -f`** — remove functions
8. **`date`, `sleep`** — misc utilities
9. **`set -u` enforcement** — nounset mode
10. **Glob expansion** — needed for `ls *.txt` style usage
11. **`awk`**, and the missing `sed` pieces (`a`/`i`/`c`, blocks, `-i`) — complex; consider wasm or partial implementation

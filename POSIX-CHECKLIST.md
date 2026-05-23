# POSIX Shell Compatibility Checklist

Track progress toward a POSIX-compliant `sh` implementation in Brsh-JS.

---

## Shell Syntax & Built-in Behaviour

### Operators / Redirection
- [x] Pipes (`|`) — `cmd1 | cmd2`
- [x] Logical AND (`&&`)
- [x] Logical OR (`||`)
- [x] Sequential (`;`)
- [x] Output redirect (`>`, `>>`)
- [ ] Input redirect (`<`)
- [ ] Here-doc (`<<EOF … EOF`)
- [ ] Here-string (`<<<`)
- [ ] Process substitution (`<(cmd)`, `>(cmd)`) *(non-POSIX but common)*

### Control Flow
- [x] `if` / `elif` / `else` / `fi`
- [x] `while` / `do` / `done`
- [x] `for var in list; do … done`
- [x] `case … in … esac`
- [ ] `break [n]` — exit loop
- [ ] `continue [n]` — next iteration
- [ ] Subshell `( cmds )`

### Functions
- [x] `name() { … }` definition
- [x] `function name { … }` definition
- [x] `return [n]`
- [x] Positional parameters (`$1`, `$2`, … inside function)
- [ ] `local var` — function-scoped variables

### Variable Expansion
- [x] `$VAR` / `${VAR}`
- [x] `$?` — last exit code
- [x] `$#` — positional parameter count
- [x] `$1` … `$n` — positional parameters
- [ ] `$@` — all positional params as separate words
- [ ] `$*` — all positional params as single word
- [ ] `$0` — script / shell name
- [ ] `$$` — current PID *(can be faked)*
- [ ] `${var:-default}` — use default if unset/empty
- [ ] `${var:=default}` — assign default if unset/empty
- [ ] `${var:?error}` — error if unset/empty
- [ ] `${var:+alt}` — use alt if set
- [ ] `${#var}` — string length
- [ ] `${var#pattern}` — strip shortest prefix
- [ ] `${var##pattern}` — strip longest prefix
- [ ] `${var%pattern}` — strip shortest suffix
- [ ] `${var%%pattern}` — strip longest suffix
- [ ] `${var/from/to}` — replace first *(non-POSIX but common)*
- [ ] `${var//from/to}` — replace all *(non-POSIX but common)*

### Expansion
- [x] Command substitution `$(cmd)`
- [x] Arithmetic expansion `$((expr))`
- [ ] Tilde expansion (`~`, `~user`)
- [ ] Filename glob expansion (`*`, `?`, `[a-z]`)
- [ ] Brace expansion `{a,b,c}` *(non-POSIX but common)*

### Special Built-ins (POSIX required)
- [x] `exit [n]`
- [x] `export VAR=val`
- [x] `return [n]`
- [x] `set` (flags + positional params)
- [x] `source` / `. script` *(`.` alias missing — see below)*
- [x] `.` — dot command (alias for `source`)
- [ ] `:` — no-op, always exits 0
- [ ] `break [n]`
- [ ] `continue [n]`
- [ ] `shift [n]`
- [ ] `unset var`
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
- [ ] `tail`
- [ ] `sort`
- [ ] `uniq`
- [ ] `tr`
- [ ] `cut`
- [ ] `tee` *(requires pipe support)*
- [ ] `sed`
- [ ] `awk`

### Filesystem
- [x] `ls`
- [x] `cp`
- [x] `mv`
- [x] `rm`
- [x] `mkdir`
- [x] `chmod`
- [x] `cd` / `pwd`
- [ ] `touch`
- [ ] `find`
- [ ] `ln` (symlinks)
- [ ] `stat`

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
- [ ] `test` (as standalone command) — `[` and `[[` covered by `test` builtin
- [x] `which`
- [x] `true`
- [x] `false`
- [x] `read`
- [x] `alias`
- [x] `exit`

---

## Priority Order

1. **Pipes (`|`)** — unlocks most shell idioms; highest value
2. **`break` / `continue`** — small change, very common in loops
3. **`shift` / `unset` / `.` / `:`** — small special builtins, high frequency in scripts
4. **`$@` / `$*` / `$0`** — needed for argument-forwarding patterns
5. **`${var:-default}` parameter expansion forms** — very common in real scripts
6. **`wc`, `head`, `tail`, `sort`, `uniq`, `tr`, `cut`** — most-used text utilities
7. **`basename` / `dirname`** — common path helpers
8. **`local`** — function-scoped variables
9. **`date`, `sleep`, `touch`** — misc utilities
10. **`set -u` enforcement** — nounset mode
11. **Glob expansion** — needed for `ls *.txt` style usage
12. **`sed` / `awk`** — complex; consider wasm or partial implementation

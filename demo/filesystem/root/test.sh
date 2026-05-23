#!/bin/sh

# ── helper function ──────────────────────────────────────────────────────────
describe_number() {
  case "$1" in
    1) echo "one" ;;
    2) echo "two" ;;
    3) echo "three" ;;
    [4-9]) echo "a single digit greater than three" ;;
    *) echo "something else entirely" ;;
  esac
}

# ── for loop ─────────────────────────────────────────────────────────────────
echo "--- for loop ---"
for n in 1 2 3 4 7 42; do
  printf "%s is: " "$n"
  describe_number "$n"
done

# ── if / elif / else ─────────────────────────────────────────────────────────
echo "--- if/elif/else ---"
export SCORE=75
if [ "$SCORE" -ge 90 ]; then
  echo "Grade: A"
elif [ "$SCORE" -ge 75 ]; then
  echo "Grade: B"
elif [ "$SCORE" -ge 60 ]; then
  echo "Grade: C"
else
  echo "Grade: F"
fi

# ── interactive read ─────────────────────────────────────────────────────────
echo "--- interactive read ---"
printf "Enter your name: "
read USER_NAME
echo "Hello, $USER_NAME!"

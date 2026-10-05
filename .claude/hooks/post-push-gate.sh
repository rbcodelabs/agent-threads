#!/bin/sh
# PostToolUse(Bash): after a `git push`, inject the quality-gate checklist.
# The message lives in post-push-gate.txt, NOT inline in settings.json or a
# shell string, so apostrophes/quotes in it can never break shell quoting
# (an inline `PR's` once broke the hook on every Bash call).
dir=$(dirname "$0")
cmd=$(jq -r '.tool_input.command // ""')
case "$cmd" in
  *"git push"*) ;;
  *) exit 0 ;;
esac
jq -n --rawfile m "$dir/post-push-gate.txt" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:($m|rtrimstr("\n"))}}'

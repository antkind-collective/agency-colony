#!/usr/bin/env bash
# Every push that changes what people see must add a line to changelog.json
# (28 Sep 2026): the home page's "What's new in Colony" reads it, and
# it sat unedited for six months while a lot shipped.
#
# Usage: scripts/check-changelog.sh <base> <head>
# Passes when the range touches no user-facing file, when it touches
# changelog.json, or when a commit message in the range says [no-changelog]
# (for a visible-but-trivial change; the reason then lives in the commit).
set -euo pipefail
base="$1"; head="$2"
files=$(git diff --name-only "$base" "$head")
visible=$(printf '%s\n' "$files" | grep -E '^(app\.js|index\.html|styles\.css|js/|circle/|netlify/functions/lib/email|netlify/functions/.*(notify|nudge|reminder)[^/]*\.js$)' || true)
[ -z "$visible" ] && exit 0
printf '%s\n' "$files" | grep -qx 'changelog.json' && exit 0
git log --format=%B "$base..$head" | grep -q '\[no-changelog\]' && exit 0
{
  echo "✋ This push changes what people see but adds nothing to changelog.json:"
  printf '   %s\n' $visible | head -8
  echo "   Add a plain-words line (newest first) for the home page's \"What's new\","
  echo "   with \"audience\": leadership | hiring | briefs | admin when it isn't for everyone,"
  echo "   or put [no-changelog] in a commit message if nobody would notice."
} >&2
exit 1

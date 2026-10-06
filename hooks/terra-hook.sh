#!/bin/sh
# Claude Code hook for Terra, the desktop pet: tells the pet what Claude is doing.
#
#   terra-hook.sh <prompt|tool|notify|stop|session-start|error>   (hook JSON on stdin)
#
# Without an argument the event is worked out from hook_event_name in the JSON.
# It must never slow Claude Code down: it prints nothing (stdout from some hooks is
# added to Claude's context), gives up after 1 second, always exits 0, and does
# nothing when the pet isn't running. Prompt text only travels through pipes, never
# argv or files, so it doesn't show up in `ps` or on disk.

exec >/dev/null 2>&1

PORT_FILE="$HOME/.terra-pet/port"
MAX_PROMPT=10000 # characters; a longer prompt is sent without its text

input=$(cat)
event=$1

if [ -z "$event" ] && command -v jq >/dev/null; then
  case $(printf '%s' "$input" | jq -r '.hook_event_name // empty') in
    UserPromptSubmit) event=prompt ;;
    PreToolUse) event=tool ;;
    Notification) event=notify ;;
    Stop) event=stop ;;
    StopFailure | PostToolUseFailure) event=error ;;
    SessionStart) event=session-start ;;
  esac
fi

case $event in
  prompt | tool | notify | stop | session-start | error) ;;
  *) exit 0 ;;
esac

# The pet writes its port here while it runs and removes it on quit.
port=$(cat "$PORT_FILE")
case $port in
  '' | *[!0-9]*) exit 0 ;;
esac

body="{\"event\":\"$event\"}"
if [ "$event" = prompt ] && command -v jq >/dev/null; then
  # Pasted blocks aren't the user's own words, and keep the body under the pet's 64 KB limit.
  body=$(printf '%s' "$input" | jq -c --arg event "$event" --argjson max "$MAX_PROMPT" '
    (.prompt // "" | gsub("<pasted_content id=\"[^\"]*\">[\\s\\S]*?</pasted_content id=\"[^\"]*\">"; " ")) as $p
    | {event: $event} + (if ($p | length) <= $max then {prompt: $p} else {} end)') ||
    body="{\"event\":\"$event\"}"
fi

printf '%s' "$body" | curl -q --silent --output /dev/null --noproxy '*' --max-time 1 \
  --header 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$port/event"

exit 0

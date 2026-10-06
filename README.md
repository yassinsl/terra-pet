# Terra

A pixel-art desktop pet for macOS, built with Electron.

Terra lives in a small transparent window that stays on top. It waves when it starts,
idles and blinks, walks along the bottom of the screen now and then, and falls asleep
after 5 minutes of idling. Reactions show an emote above it: a speech bubble, hearts,
a lightbulb, stars...

- Drag Terra to move it. Only Terra itself catches the mouse; clicks anywhere else in its
  window, including the emote area, go through to whatever is behind.
- Click it and it loves you; click 5 times fast and it gets dizzy. A click wakes it up.
- Menu bar icon: the listener status, **Play animation** (any of the 19), **Play reaction**
  (any of the 8 emotes), **Back to idle**, **Patrol** (walking on/off), **Quit**.
- With the Claude Code hooks installed, Terra follows what Claude is doing (see below).

## Run

Requires Node.js and npm.

```sh
npm install
npm start
```

## Claude Code hooks

```sh
npm run hooks:install     # adds Terra's hooks to ~/.claude/settings.json
npm run hooks:uninstall   # removes them again
```

The installer backs up `settings.json` first (`settings.json.terra-backup-<timestamp>`),
only adds or removes Terra's own entries, and prints exactly what it changed. Running it
twice changes nothing. Re-run it if you move this folder. Add `-- --settings <path>` to
use another settings file.

| Claude Code event | Terra |
| :- | :- |
| `UserPromptSubmit` | a reaction if the prompt has a keyword (`reactions.js`), then sits down to work |
| `PreToolUse` | sits down to work, unless it already is |
| `Notification` (Claude is waiting on you) | asks (question mark) |
| `Stop` | happy, with stars, then idle |
| `StopFailure` (the turn ended on an API error) | dizzy, then idle |
| `SessionStart` (startup, resume, clear) | waves |

If Terra sits in work, sitDown, wait, think or ask for 10 minutes with no event (for
example after you interrupt Claude with Esc, which fires no hook), it goes back to idle.
**Back to idle** in the menu does the same at once.

`hooks/terra-hook.sh` sends each event to Terra's listener on `127.0.0.1:47800` (or the
next free port, written to `~/.terra-pet/port`). The hook runs in the background, gives up
after 1 second and does nothing when Terra isn't running, so it never slows Claude Code
down. Prompt text is only used for the keyword match; it is never written to disk or logs.

## Tests

```sh
npm test            # everything, about 3 minutes
npm test -- unit    # only the fast tests (no window)
```

The end-to-end tests run the real app: a second Terra appears and moves around, so leave
it alone (they retry a check that was disturbed by your mouse) and keep the screen on.
They use a temporary home folder, so they don't touch a Terra you are running or its
port file, and they never touch `~/.claude/settings.json`.

## Layout

- `main.js`: window, tray menu, mouse pass-through, patrol routes, hook events to states, the 10-minute timeout
- `listener.js`: the local HTTP listener for hook events
- `reactions.js`: the prompt keyword table
- `hooks/terra-hook.sh`: the Claude Code hook script
- `scripts/`: the hook installer and uninstaller
- `preload.js`: the IPC bridge between the page and the main process
- `renderer/animations.js`: the animation table (row, frames, timing, what plays next)
- `renderer/emotes.js`: the emote table (frames, timing, the pet animation it goes with)
- `renderer/pet.js`: drawing, the state machine (`setState`, `playReaction`), idle behaviour, clicks and drag
- `renderer/index.html`: the page with the canvas
- `test/`: unit tests and end-to-end tests (`test/run.js` runs them all)
- `Bot/`: art. `Bot/spritesheet-x1.png` (48x52 cells, 8 columns, 19 rows) and
  `Bot/reactions/emotes-only/<name>-<n>.png` (64x80, the pet's cell sits at 8,28)

The window is the 64x80 emote canvas at 4x (256x320) with Terra in its bottom 192x208.
The main process changes the animation over IPC: `pet:set-state` (`setPetState(name)`)
and `pet:play-reaction` (`playPetReaction(name)`); the tray menu uses the same path.

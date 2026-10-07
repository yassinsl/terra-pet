# Contributing to Terra

Thanks for helping! Bug reports, new trigger words, skins, animations and fixes are all
welcome.

## Getting started

```sh
npm install
npm start
npm test
```

Terra is plain JavaScript with no framework and no bundler. The README's
[How it fits together](README.md#how-it-fits-together) section says what each file does.

## Before you open a pull request

- Run `npm test` and make sure everything passes. The end-to-end tests open a second
  Terra window for a few minutes; leave it alone and keep the screen on.
- Add or update a test when you change behaviour: `test/unit/` for plain logic,
  `test/e2e/` for anything you can see on screen.
- Keep to the style around you: small functions, short comments that say why.
- Keep Terra local and private: no network calls beyond `127.0.0.1`, and never store or
  log prompt text.
- Never touch the real `~/.claude/settings.json` in tests; pass `--settings <temp file>`.
- Tests run with a temporary `HOME` and data folder. To run a second Terra next to yours
  by hand, do the same: `HOME=/tmp/terra-dev TERRA_USER_DATA=/tmp/terra-dev/data npm start`
  (a separate `HOME` keeps its port file apart, `TERRA_USER_DATA` its saved settings).
  The same goes for the Claude desktop config: pass `--config <temp file>`.
- The Claude desktop tools send Terra only names from `pet-commands.js`. Keep it that way:
  no free text from the MCP server to the listener.

## Art

New art goes in `Bot/` and follows the layout in the README
([Make your own skin or animation](README.md#make-your-own-skin-or-animation)). If you
change the idle frame, run `npm run icons` to redraw the app and menu bar icons.

## Reporting a bug

Say what you did, what you expected and what happened, plus your macOS version, your Mac
(Apple Silicon or Intel), and whether you run the app or `npm start`. Please leave your
prompts out of bug reports.

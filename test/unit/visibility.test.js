// visibility.js (when Terra is shown) and claude-app.js (is the Claude desktop app open).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, check, section, summary } = require('../lib.js');
const v = require(path.join(ROOT, 'visibility.js'));
const claude = require(path.join(ROOT, 'claude-app.js'));

const MIN = 60 * 1000;
const now = 100 * MIN;

section('Show Terra modes');
check('three modes, default "only while Claude desktop is running"', v.MODES.map((m) => m.id).join() === 'claude,claude-or-code,always' && v.DEFAULT_MODE === 'claude',
  v.MODES.map((m) => m.label).join(' | '));
const cases = [
  // mode, Claude desktop running, last Claude Code event (minutes ago, null: none), shown?
  ['claude', true, null, true],
  ['claude', false, null, false],
  ['claude', false, 1, false], // a Claude Code session doesn't count in this mode
  ['claude-or-code', true, null, true],
  ['claude-or-code', false, null, false],
  ['claude-or-code', false, 0, true],
  ['claude-or-code', false, 9.99, true],
  ['claude-or-code', false, 10, false], // 10 minutes after the last event: over
  ['claude-or-code', false, 30, false],
  ['always', false, null, true],
  ['always', true, null, true],
  ['nonsense', false, 1, false],
];
for (const [mode, claudeRunning, ago, want] of cases) {
  const got = v.shouldShow({ mode, claudeRunning, lastCodeEventAt: ago === null ? 0 : now - ago * MIN, now });
  check(`  ${mode}, Claude ${claudeRunning ? 'open' : 'closed'}, Claude Code ${ago === null ? 'never' : `${ago} min ago`}`, got === want, got ? 'shown' : 'hidden');
}

section('preferences file');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-prefs-'));
  const file = path.join(dir, 'preferences.json');
  check('no file: defaults', JSON.stringify(v.loadPrefs(file)) === JSON.stringify({ showWhen: 'claude', loginItemDefaultDone: false }));
  v.savePrefs(file, { showWhen: 'always', loginItemDefaultDone: true });
  check('saved and read back', JSON.stringify(v.loadPrefs(file)) === JSON.stringify({ showWhen: 'always', loginItemDefaultDone: true }), fs.readFileSync(file, 'utf8').replace(/\s+/g, ' '));
  fs.writeFileSync(file, JSON.stringify({ showWhen: 'sometimes' }));
  check('unknown mode: default', v.loadPrefs(file).showWhen === 'claude');
  fs.writeFileSync(file, '{ damaged');
  check('damaged file: defaults', v.loadPrefs(file).showWhen === 'claude' && v.loadPrefs(file).loginItemDefaultDone === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

section('Claude desktop detection (lsappinfo, without asking about Claude itself)');
check('bundle identifier', claude.BUNDLE_ID === 'com.anthropic.claudefordesktop' && claude.POLL_MS === 3000, `${claude.BUNDLE_ID}, every ${claude.POLL_MS / 1000} s`);
check('parses a running app', claude.parse('ASN:0x0-0xbabbab-"Claude":\n') === true);
check('parses "not running"', claude.parse('') === false);
// The same command main uses, on an app that is always open and one that doesn't exist.
const ask = (id) => execFileSync('/usr/bin/lsappinfo', ['find', `bundleid=${id}`], { encoding: 'utf8' });
check('lsappinfo finds Finder', claude.parse(ask('com.apple.finder')));
check('lsappinfo finds nothing for a made-up app', !claude.parse(ask('com.example.terra.not.an.app')));

process.exitCode = summary() ? 1 : 0;

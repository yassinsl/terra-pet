// scripts/install-hooks.js and uninstall-hooks.js on temporary settings files.
// Never touches the real ~/.claude/settings.json: every run passes --settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, check, section, summary } = require('../lib.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'terra-installer-'));
const HOOK = path.join(ROOT, 'hooks', 'terra-hook.sh');
const EVENTS = { UserPromptSubmit: 'prompt', PreToolUse: 'tool', Notification: 'notify', Stop: 'stop', StopFailure: 'error', SessionStart: 'session-start' };

function run(script, file) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), '--settings', file], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).replaceAll(tmp, '<tmp>') };
}
const install = (f) => run('install-hooks.js', f);
const uninstall = (f) => run('uninstall-hooks.js', f);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const backups = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.terra-backup-')).sort();

// Terra handlers per event, keys sorted: { PreToolUse: ['tool'], ... }
function terraEntries(settings) {
  const found = {};
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        const m = typeof h.command === 'string' && h.command.match(/terra-hook\.sh' (\S+)$/);
        if (m) (found[event] = found[event] || []).push(m[1]);
      }
    }
  }
  return Object.fromEntries(Object.keys(found).sort().map((k) => [k, found[k]]));
}
const expectedEntries = Object.fromEntries(Object.keys(EVENTS).sort().map((e) => [e, [EVENTS[e]]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lines = (out, heading) => (out.split(`${heading}:\n`)[1] || '').split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim().split(':')[0]);

// Shaped like a real user settings file (fake values).
const FIXTURE = {
  env: { SOME_TOKEN: 'not-a-real-secret' },
  permissions: { allow: ['Bash(npm test:*)'], deny: [] },
  model: 'opus',
  theme: 'dark',
  enabledPlugins: { 'swift-lsp@claude-plugins-official': true },
};

section('install, install again, uninstall, uninstall again');
{
  const dir = path.join(tmp, 'plain');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'settings.json');
  const original = `${JSON.stringify(FIXTURE, null, 2)}\n`;
  fs.writeFileSync(file, original);

  let r = install(file);
  const after = read(file);
  check('install adds all 6 events, incl. StopFailure', r.code === 0 && same(terraEntries(after), expectedEntries) && same(lines(r.out, 'Added').sort(), Object.keys(EVENTS).sort()),
    `added: ${lines(r.out, 'Added').join(', ')}`);
  const sf = after.hooks.StopFailure[0];
  check('StopFailure entry: no matcher, async, runs "error"', !('matcher' in sf) && sf.hooks[0].async === true && sf.hooks[0].command === `/bin/sh '${HOOK}' error`, JSON.stringify(sf));
  const { hooks, ...rest } = after;
  check('every other setting untouched', same(rest, FIXTURE));
  check('backup made first, with the old content', backups(dir).length === 1 && fs.readFileSync(path.join(dir, backups(dir)[0]), 'utf8') === original, backups(dir).join(', '));

  r = install(file);
  check('install again: no duplicates, no change', r.code === 0 && /already installed/.test(r.out) && same(terraEntries(read(file)), expectedEntries) && backups(dir).length === 1, r.out.split('\n')[1]);

  r = uninstall(file);
  check('uninstall removes all 6, incl. StopFailure', r.code === 0 && same(lines(r.out, 'Removed').sort(), Object.keys(EVENTS).sort()), `removed: ${lines(r.out, 'Removed').join(', ')}`);
  check('file is byte-for-byte the original again', fs.readFileSync(file, 'utf8') === original);
  r = uninstall(file);
  check('uninstall again: nothing to do', r.code === 0 && /No Terra hooks found/.test(r.out), r.out.split('\n')[1]);
}

section('upgrading a step 3 install (no StopFailure yet)');
{
  const dir = path.join(tmp, 'upgrade');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'settings.json');
  const step3 = { ...FIXTURE, hooks: {} };
  for (const [event, arg] of Object.entries(EVENTS)) {
    if (event === 'StopFailure') continue;
    const handler = { type: 'command', command: `/bin/sh '${HOOK}' ${arg}`, async: true, timeout: 5 };
    const group = { Notification: 'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog', SessionStart: 'startup|resume|clear' }[event];
    step3.hooks[event] = [group ? { matcher: group, hooks: [handler] } : { hooks: [handler] }];
  }
  fs.writeFileSync(file, `${JSON.stringify(step3, null, 2)}\n`);
  const r = install(file);
  check('install adds only StopFailure', r.code === 0 && same(lines(r.out, 'Added'), ['StopFailure']) && !/Removed/.test(r.out) && same(terraEntries(read(file)), expectedEntries),
    `added: ${lines(r.out, 'Added').join(', ')}`);
}

section('symlinked settings.json with your own hooks');
{
  const dir = path.join(tmp, 'link');
  fs.mkdirSync(path.join(dir, 'dotfiles'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'));
  const real = path.join(dir, 'dotfiles', 'claude-settings.json');
  const own = {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
      StopFailure: [{ matcher: 'rate_limit', hooks: [{ type: 'command', command: '~/bin/alert.sh' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/check-bash.sh', timeout: 10 }] }],
    },
  };
  fs.writeFileSync(real, `${JSON.stringify(own, null, 2)}\n`);
  const link = path.join(dir, '.claude', 'settings.json');
  fs.symlinkSync('../dotfiles/claude-settings.json', link);

  let r = install(link);
  const s = read(real);
  check('link stays a link, real file edited', fs.lstatSync(link).isSymbolicLink() && same(terraEntries(s), expectedEntries), /symlink to/.test(r.out) ? 'output names the real file' : r.out);
  check('your own hooks kept, Terra added after them',
    s.hooks.Stop[0].hooks[0].command.startsWith('afplay') && s.hooks.StopFailure[0].matcher === 'rate_limit' && s.hooks.StopFailure.length === 2 && s.hooks.PreToolUse[0].matcher === 'Bash',
    `StopFailure groups: ${s.hooks.StopFailure.map((g) => g.matcher || '(all)').join(', ')}`);
  check('backup sits next to the link', backups(path.join(dir, '.claude')).length === 1, backups(path.join(dir, '.claude')).join(', '));
  r = uninstall(link);
  check('uninstall: link intact, your hooks back as they were', fs.lstatSync(link).isSymbolicLink() && same(read(real), own));
}

section('missing file, invalid JSON, old Terra path');
{
  const dir = path.join(tmp, 'none');
  fs.mkdirSync(dir);
  const file = path.join(dir, '.claude', 'settings.json');
  let r = install(file);
  check('no settings.json: created with Terra only', r.code === 0 && /new file/.test(r.out) && same(terraEntries(read(file)), expectedEntries) && (fs.statSync(file).mode & 0o777) === 0o600,
    `mode ${(fs.statSync(file).mode & 0o777).toString(8)}`);

  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{ "model": "opus", }\n');
  r = install(bad);
  check('invalid JSON: refused, file untouched, no backup', r.code === 1 && /not valid JSON/.test(r.out) && fs.readFileSync(bad, 'utf8') === '{ "model": "opus", }\n' && backups(tmp).length === 0, r.out.split('\n')[0]);

  const moved = path.join(tmp, 'moved.json');
  fs.writeFileSync(moved, JSON.stringify({ hooks: { StopFailure: [{ hooks: [{ type: 'command', command: "/bin/sh '/old/place/hooks/terra-hook.sh' error", async: true }] }] } }));
  r = install(moved);
  const m = read(moved);
  check('old Terra path replaced, not duplicated', m.hooks.StopFailure.length === 1 && m.hooks.StopFailure[0].hooks[0].command.includes(ROOT) && /Removed \(old Terra entries\)/.test(r.out));
}

fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = summary() ? 1 : 0;

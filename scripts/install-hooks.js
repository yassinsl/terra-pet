// Adds Terra's hooks to Claude Code's user settings (~/.claude/settings.json).
// Merge only: every other setting and hook is left as it is. Safe to run again.
// Usage: npm run hooks:install [-- --settings <path>]
const fs = require('node:fs');
const {
  ENTRIES, HOOK_SCRIPT, terraGroup, isTerraHandler, settingsPathFromArgs, readSettings, writeSettings, printTarget, show,
} = require('./hooks-settings.js');

const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

if (!fs.existsSync(HOOK_SCRIPT)) {
  console.error(`Error: hook script not found at ${HOOK_SCRIPT}`);
  process.exit(1);
}
fs.chmodSync(HOOK_SCRIPT, 0o755);

const target = readSettings(settingsPathFromArgs());
const hooks = target.settings.hooks || {};
const added = [];
const removed = [];

for (const entry of ENTRIES) {
  const want = terraGroup(entry);
  const groups = hooks[entry.hookEvent];
  if (groups !== undefined && !Array.isArray(groups)) {
    console.error(`Error: hooks.${entry.hookEvent} is not a list. Nothing was changed.`);
    process.exit(1);
  }
  const list = groups || [];
  const terraGroups = list.filter((g) => Array.isArray(g?.hooks) && g.hooks.some(isTerraHandler));
  if (terraGroups.length === 1 && same(terraGroups[0], want)) continue; // already installed

  // Replace any older or partial Terra entry for this event (for example after moving the repo).
  const kept = [];
  for (const group of list) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some(isTerraHandler)) {
      kept.push(group);
      continue;
    }
    for (const h of group.hooks.filter(isTerraHandler)) removed.push(show(entry.hookEvent, { ...group, hooks: [h] }));
    const others = group.hooks.filter((h) => !isTerraHandler(h));
    if (others.length) kept.push({ ...group, hooks: others });
  }
  kept.push(want);
  hooks[entry.hookEvent] = kept;
  added.push(show(entry.hookEvent, want));
}

printTarget(target);
if (!added.length) {
  console.log("Terra's hooks are already installed. Nothing changed, no backup needed.");
  process.exit(0);
}
target.settings.hooks = hooks;
const backup = writeSettings(target);
if (backup) console.log(`Backup:   ${backup}`);
if (removed.length) console.log(`Removed (old Terra entries):\n${removed.join('\n')}`);
console.log(`Added:\n${added.join('\n')}`);
console.log('Nothing else in the file was changed.');

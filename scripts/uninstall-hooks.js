// Removes Terra's hooks from Claude Code's user settings (~/.claude/settings.json).
// Only Terra's entries go; every other setting and hook is left as it is.
// Usage: npm run hooks:uninstall [-- --settings <path>]
const { isTerraHandler, settingsPathFromArgs, readSettings, writeSettings, printTarget, show } = require('./hooks-settings.js');

const target = readSettings(settingsPathFromArgs());
const hooks = target.settings.hooks || {};
const removed = [];

for (const [hookEvent, groups] of Object.entries(hooks)) {
  if (!Array.isArray(groups)) continue;
  const kept = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks) || !group.hooks.some(isTerraHandler)) {
      kept.push(group);
      continue;
    }
    for (const h of group.hooks.filter(isTerraHandler)) removed.push(show(hookEvent, { ...group, hooks: [h] }));
    const others = group.hooks.filter((h) => !isTerraHandler(h));
    if (others.length) kept.push({ ...group, hooks: others });
  }
  if (kept.length === groups.length && kept.every((g, i) => g === groups[i])) continue;
  // Drop the event (and "hooks") only when removing Terra's entries emptied it.
  if (kept.length) hooks[hookEvent] = kept;
  else delete hooks[hookEvent];
}

printTarget(target);
if (!removed.length) {
  console.log('No Terra hooks found. Nothing changed, no backup needed.');
  process.exit(0);
}
if (Object.keys(hooks).length) target.settings.hooks = hooks;
else delete target.settings.hooks;
const backup = writeSettings(target);
if (backup) console.log(`Backup:   ${backup}`);
console.log(`Removed:\n${removed.join('\n')}`);
console.log('Nothing else in the file was changed.');

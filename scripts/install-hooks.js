// Adds Terra's hooks to Claude Code's user settings (~/.claude/settings.json).
// Merge only: every other setting and hook is left as it is. Safe to run again.
// Usage: npm run hooks:install [-- --settings <path>]
const { install, settingsPathFromArgs } = require('../hook-installer.js');

const { code, text } = install(settingsPathFromArgs(process.argv.slice(2)));
(code ? console.error : console.log)(text);
process.exitCode = code;

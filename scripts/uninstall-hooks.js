// Removes Terra's hooks from Claude Code's user settings (~/.claude/settings.json).
// Only Terra's entries go; every other setting and hook is left as it is.
// Usage: npm run hooks:uninstall [-- --settings <path>]
const { uninstall, settingsPathFromArgs } = require('../hook-installer.js');

const { code, text } = uninstall(settingsPathFromArgs(process.argv.slice(2)));
(code ? console.error : console.log)(text);
process.exitCode = code;

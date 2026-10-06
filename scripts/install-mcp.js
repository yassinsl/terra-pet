// Adds Terra's MCP server to the Claude desktop app's config
// (~/Library/Application Support/Claude/claude_desktop_config.json).
// Merge only: every other server and setting is left as it is. Safe to run again.
// Usage: npm run mcp:install [-- --config <path>]
const { install, configPathFromArgs } = require('../mcp-installer.js');

const { code, text } = install(configPathFromArgs(process.argv.slice(2)));
(code ? console.error : console.log)(text);
process.exitCode = code;

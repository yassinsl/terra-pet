// Removes Terra's MCP server from the Claude desktop app's config
// (~/Library/Application Support/Claude/claude_desktop_config.json).
// Only Terra's entry goes; every other server and setting is left as it is.
// Usage: npm run mcp:uninstall [-- --config <path>]
const { uninstall, configPathFromArgs } = require('../mcp-installer.js');

const { code, text } = uninstall(configPathFromArgs(process.argv.slice(2)));
(code ? console.error : console.log)(text);
process.exitCode = code;

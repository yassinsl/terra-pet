// What the Claude desktop app may ask of Terra: mcp/terra-mcp.js -> POST /mcp -> main.js.
// Fixed names only, so no free text ever travels this way.
//
// REACTIONS are emotes from renderer/emotes.js. STATES map to the pet like this:
//   working -> sits down at its computer      waiting -> asks, with a question mark
//   done    -> happy, with stars, then idle   idle    -> stands up (if it was working) and idles
const REACTIONS = ['hi', 'love', 'angry', 'sad', 'idea', 'stars', 'talk', 'ask'];
const STATES = ['working', 'waiting', 'done', 'idle'];

module.exports = { REACTIONS, STATES };

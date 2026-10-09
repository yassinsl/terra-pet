// What the Claude desktop app may ask of Terra: mcp/terra-mcp.js -> POST /mcp -> main.js.
// Fixed names only, apart from done's short speech bubble line (checked in listener.js).
//
// REACTIONS are emotes from renderer/emotes.js. STATES map to the pet like this:
//   working -> sits down at its computer      waiting -> asks, with a question mark
//   done    -> stands up, shows its MOOD, idles  idle -> stands up (if it was working) and idles
//              (done also carries "say": its speech bubble line, shown meanwhile)
// MOODS go with "done" only:
//   happy -> stars   sad -> looks sad   angry -> looks angry   neutral -> nothing, just idles
// With no mood, the last reaction since "working" decides (sad or angry: neutral, any
// other: happy), and with no reaction either it is neutral.
// They play one after another, each to its end (see the queue in renderer/pet.js).
const REACTIONS = ['hi', 'love', 'angry', 'sad', 'idea', 'stars', 'talk', 'ask'];
const STATES = ['working', 'waiting', 'done', 'idle'];
const MOODS = ['happy', 'sad', 'angry', 'neutral'];

module.exports = { REACTIONS, STATES, MOODS };

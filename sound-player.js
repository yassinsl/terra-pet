// Plays Terra's sound effects with macOS's own afplay, from the main process: the one way
// Terra makes a sound. renderer/sounds.js decides which sound and when (main.js applies its
// rules); this only makes the noise.
//
// The packaged app keeps its files in app.asar, which afplay can't read, so electron-builder
// unpacks Bot/sounds/ next to it (asarUnpack in package.json): app.asar.unpacked/Bot/sounds.
// Under npm start this is just the project's Bot/sounds.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AFPLAY = '/usr/bin/afplay';
const SOUND_DIR = path.join(__dirname, 'Bot', 'sounds').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

const fileOf = (name) => path.join(SOUND_DIR, `${name}.wav`);

function soundFileCount() {
  try {
    return fs.readdirSync(SOUND_DIR).filter((n) => n.endsWith('.wav')).length;
  } catch {
    return 0;
  }
}

let problemLogged = false;
function logProblemOnce(message) {
  if (problemLogged) return;
  problemLogged = true;
  console.error(`Terra: a sound effect could not play (${message})`);
}

// Starts `afplay -v <volume> <file>` detached from Terra (no stdio, nothing waits on it) and
// resolves to its exit code when it ends (null if it couldn't start). Used as
// player.play(...) so the tests can put a fake in its place.
function play(name, volume) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(AFPLAY, ['-v', String(volume), fileOf(name)], { stdio: 'ignore', detached: true });
    } catch (err) {
      logProblemOnce(`${name}: ${err.message}`);
      resolve(null);
      return;
    }
    child.unref();
    child.on('error', (err) => {
      logProblemOnce(`${name}: ${err.message}`);
      resolve(null);
    });
    child.on('exit', (code) => {
      if (code !== 0) logProblemOnce(`${name}: afplay exited with ${code}`);
      resolve(code);
    });
  });
}

module.exports = { AFPLAY, SOUND_DIR, fileOf, soundFileCount, play };

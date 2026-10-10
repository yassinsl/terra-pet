// voice.js with a fake say process: reading `say -v '?'`, the friendly default, what is
// said (as written, no say [[commands]], capped), the arguments (never the text), the text
// going in on stdin, stopping, and a new line stopping the one being said.
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ROOT, check, section, summary, PROMPT_MARK } = require('../lib.js');
const voice = require(path.join(ROOT, 'voice.js'));

const json = (v) => JSON.stringify(v);

section("say -v '?' -> the English voices");
{
  const out = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Amélie              fr_CA    # Bonjour, je m’appelle Amélie.',
    'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
    'Karen               en_AU    # Hello! My name is Karen.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Yuna                ko_KR    # 안녕하세요. 제 이름은 유나입니다.',
    '',
  ].join('\n');
  const list = voice.parseVoices(out);
  check('  English only, names with spaces and brackets kept', json(list.map((v) => v.name)) === json(['Albert', 'Eddy (English (UK))', 'Karen', 'Samantha']), list.map((v) => `${v.name} (${v.locale})`).join(', '));
  check('  the default: a friendly one (Samantha) when installed', voice.defaultVoice(list) === 'Samantha');
  check('  else the next friendly one, else the first English voice, else say\'s own', voice.defaultVoice(list.filter((v) => v.name !== 'Samantha')) === 'Karen'
    && voice.defaultVoice([{ name: 'Albert' }]) === 'Albert' && voice.defaultVoice([]) === null);
}

section('what is said');
{
  check('  as written, on one line', voice.speechText('Paris is the capital\nof France!') === 'Paris is the capital of France!');
  check('  no control characters, no say [[commands]]', voice.speechText('Hi[[volm 0]] there\u0007[[slnc 9000]]!') === 'Hi there!', JSON.stringify(voice.speechText('Hi[[volm 0]] there\u0007[[slnc 9000]]!')));
  const long = voice.speechText('word '.repeat(200));
  check('  at most 300 characters, cut at a word', long.length <= voice.MAX_SPOKEN && long.endsWith('word'), `${long.length} characters`);
  check('  speeds: slow 160, normal 190, fast 230 words a minute', json(voice.RATES) === json({ slow: 160, normal: 190, fast: 230 }));
}

// A fake say: records its arguments and what arrives on stdin, ends when told.
const procs = [];
voice.spawnSay = (args) => {
  const p = new EventEmitter();
  p.args = args;
  p.input = '';
  p.killed = false;
  p.stdin = { on() {}, end(text) { p.input += text; } };
  p.kill = () => {
    p.killed = true;
    setImmediate(() => p.emit('exit', null));
  };
  p.finish = () => p.emit('exit', 0);
  procs.push(p);
  return p;
};

(async () => {
  section('speaking (fake say)');
  {
    const done = voice.speak(`Hi there ${PROMPT_MARK}`, { voice: 'Samantha', rate: 'fast' });
    const [p] = procs;
    check('  arguments: the voice, the speed, read stdin; never the text', json(p.args) === json(['-v', 'Samantha', '-r', '230', '-f', '-']) && !p.args.join(' ').includes('Hi there'), p.args.join(' '));
    check('  the text goes in on stdin', p.input === `Hi there ${PROMPT_MARK}`);
    check('  speaking until say ends', voice.speaking() === true);
    p.finish();
    const code = await done;
    check('  then done (exit code 0)', code === 0 && voice.speaking() === false);
  }
  {
    const first = voice.speak('One', { voice: 'Karen' });
    const second = voice.speak('Two', { voice: 'Karen' });
    const [, a, b] = procs;
    await first;
    check('  a new line stops the one being said first', a.killed === true && b.killed === false && voice.speaking() === true && b.input === 'Two');
    voice.stop();
    await second;
    check('  stop(): say is stopped, nothing is being said', b.killed === true && voice.speaking() === false);
  }
  {
    voice.speak('No voice picked');
    const p = procs[procs.length - 1];
    check('  no voice picked: say\'s own, at normal speed', json(p.args) === json(['-r', '190', '-f', '-']), p.args.join(' '));
    voice.stop();
  }
  process.exitCode = summary() ? 1 : 0;
})();

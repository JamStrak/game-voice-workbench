const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'upstream/voicebox/node_modules/typescript'));
const filename = path.join(root, 'upstream/voicebox/app/src/stores/playerStore.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: filename,
});
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { usePlayerStore: player, isAudioPlaying } = loaded.exports;

test.beforeEach(() => {
  player.getState().reset();
  player.getState().setVolume(1);
});

test('repeated idle media events do not notify store subscribers', () => {
  const original = player.getState();
  let notifications = 0;
  const unsubscribe = player.subscribe(() => { notifications += 1; });
  for (let i = 0; i < 100; i += 1) {
    original.setCurrentTime(0);
    original.setDuration(0);
    original.setIsPlaying(false);
    original.setVolume(1);
    original.clearRestartFlag();
    original.clearAutoPlayFlag();
    original.setOnFinish(null);
  }
  unsubscribe();
  assert.equal(notifications, 0);
  assert.equal(player.getState(), original);
});

test('progress frames never change preview selection, while pause and switching do', () => {
  const ids = Array.from({ length: 36 }, (_, index) => `preview-${index}`);
  const selected = ids.map(id => isAudioPlaying(player.getState(), id));
  const changes = ids.map(() => 0);
  const unsubscribe = player.subscribe(state => {
    ids.forEach((id, index) => {
      const next = isAudioPlaying(state, id);
      if (!Object.is(next, selected[index])) changes[index] += 1;
      selected[index] = next;
    });
  });
  player.getState().setAudioWithAutoPlay('/sample-a.wav', ids[0], null);
  player.getState().setIsPlaying(true);
  for (let frame = 1; frame <= 600; frame += 1) {
    player.getState().setCurrentTime(frame / 60);
  }
  assert.equal(player.getState().currentTime, 10);
  assert.deepEqual(changes, [1, ...Array(35).fill(0)]);
  player.getState().setIsPlaying(false);
  player.getState().setAudioWithAutoPlay('/sample-b.wav', ids[1], null);
  player.getState().setIsPlaying(true);
  unsubscribe();
  assert.deepEqual(changes, [2, 1, ...Array(34).fill(0)]);
});

test('repeated ready and playback events publish only real changes', () => {
  let notifications = 0;
  const unsubscribe = player.subscribe(() => { notifications += 1; });
  const finish = () => {};
  for (let repeat = 0; repeat < 5; repeat += 1) {
    player.getState().setDuration(3.5);
    player.getState().setVolume(0.5);
    player.getState().setIsPlaying(true);
    player.getState().setOnFinish(finish);
  }
  unsubscribe();
  assert.equal(notifications, 4);
  assert.equal(player.getState().onFinish, finish);
});

test('restart and autoplay flags still notify once on each transition', () => {
  player.getState().setAudioWithAutoPlay('/sample.wav', 'sample', null);
  let notifications = 0;
  const unsubscribe = player.subscribe(() => { notifications += 1; });
  player.getState().restartCurrentAudio();
  player.getState().restartCurrentAudio();
  player.getState().clearRestartFlag();
  player.getState().clearRestartFlag();
  player.getState().clearAutoPlayFlag();
  player.getState().clearAutoPlayFlag();
  unsubscribe();
  assert.equal(notifications, 3);
  assert.equal(player.getState().shouldRestart, false);
  assert.equal(player.getState().shouldAutoPlay, false);
});

test('explicitly selecting the same audio still resets its playback position', () => {
  player.getState().setAudioWithAutoPlay('/sample.wav', 'sample', 'voice', 'Sample');
  player.getState().setCurrentTime(2);
  player.getState().setIsPlaying(true);
  player.getState().clearAutoPlayFlag();
  player.getState().setAudioWithAutoPlay('/sample.wav', 'sample', 'voice', 'Sample');
  assert.equal(player.getState().currentTime, 0);
  assert.equal(player.getState().isPlaying, false);
  assert.equal(player.getState().shouldAutoPlay, true);
  assert.equal(player.getState().profileId, 'voice');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'upstream/voicebox/node_modules/typescript'));
const filename = path.join(root, 'upstream/voicebox/app/src/lib/audio-load-session.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename,
});
const loaded = new Module(filename, module);
loaded._compile(compiled.outputText, filename);
const { AudioLoadSession, audioSourceKey, createAudioProgressPublisher, fetchAudioBlob, isAudioReady, prepareAudioInstance } = loaded.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides = {}) {
  const events = [], fetches = [], decoded = [];
  const session = new AudioLoadSession({
    fetchBlob: async (url) => { fetches.push(url); return new Blob([url]); },
    loadBlob: async (blob) => { decoded.push(await blob.text()); },
    onStart: source => events.push(['start', source.key]),
    onReady: (source, blob) => events.push(['ready', source.key, blob]),
    onError: (source, error) => events.push(['error', source.key, error]),
    ...overrides,
  });
  return { session, events, fetches, decoded };
}
const source = key => ({ key, url: `/${key}.wav` });

test('four choices in one frame fetch and decode only the final choice', async () => {
  const h = harness();
  await Promise.all(['natural', 'happy', 'angry', 'sad'].map(id => h.session.load(source(id))));
  assert.deepEqual(h.fetches, ['/sad.wav']);
  assert.deepEqual(h.decoded, ['/sad.wav']);
  assert.deepEqual(h.events.filter(([event]) => event === 'ready').map(([, key]) => key), ['sad']);
});

test('superseded fetch is aborted without an error banner or stale ready', async () => {
  let firstSignal;
  const h = harness({
    fetchBlob: (url, signal) => url === '/first.wav' ? new Promise((_, reject) => {
      firstSignal = signal;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }) : Promise.resolve(new Blob([url])),
  });
  const first = h.session.load(source('first'));
  await tick();
  const second = h.session.load(source('second'));
  await Promise.all([first, second]);
  assert.equal(firstSignal.aborted, true);
  assert.equal(h.events.some(([event]) => event === 'error'), false);
  assert.deepEqual(h.events.filter(([event]) => event === 'ready').map(([, key]) => key), ['second']);
});

test('late non-cancellable decode cannot overlap or publish ready for a newer selection', async () => {
  const firstDecode = deferred();
  const decoded = [], fetches = [];
  let running = 0, maxRunning = 0;
  const h = harness({
    fetchBlob: async (url) => { fetches.push(url); return new Blob([url]); },
    loadBlob: async (blob) => {
      const name = await blob.text();
      running++; maxRunning = Math.max(maxRunning, running);
      if (name === '/old.wav') await firstDecode.promise;
      decoded.push(name); running--;
    },
  });
  const old = h.session.load(source('old'));
  await tick();
  const skipped = h.session.load(source('skipped'));
  const latest = h.session.load(source('latest'));
  await tick();
  assert.deepEqual(fetches, ['/old.wav']);
  assert.equal(h.events.some(([event]) => event === 'ready'), false);
  firstDecode.resolve();
  await Promise.all([old, skipped, latest]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(decoded, ['/old.wav', '/latest.wav']);
  assert.deepEqual(fetches, ['/old.wav', '/latest.wav']);
  assert.deepEqual(h.events.filter(([event]) => event === 'ready').map(([, key]) => key), ['latest']);
});

test('stale decode failure cannot erase a successful later selection', async () => {
  const decode = deferred();
  const h = harness({ loadBlob: async blob => { if (await blob.text() === '/old.wav') await decode.promise; } });
  const old = h.session.load(source('old'));
  await tick();
  const latest = h.session.load(source('latest'));
  decode.reject(new Error('old decode failed'));
  await Promise.all([old, latest]);
  assert.equal(h.events.some(([event]) => event === 'error'), false);
  assert.equal(h.events.at(-1)[1], 'latest');
});

test('real current failure is reported once and retrying the same source succeeds', async () => {
  let attempts = 0;
  const h = harness({ fetchBlob: async () => { if (++attempts === 1) throw new Error('HTTP 404'); return new Blob(['retry']); } });
  await h.session.load(source('missing'));
  assert.equal(h.events.filter(([event]) => event === 'error').length, 1);
  assert.match(h.events.find(([event]) => event === 'error')[2].message, /404/);
  await h.session.load(source('missing'));
  assert.equal(h.events.at(-1)[0], 'ready');
  assert.equal(attempts, 2);
});

test('unexpected current abort is not silently mistaken for a user cancellation', async () => {
  const h = harness({ loadBlob: async () => { throw new DOMException('unexpected abort', 'AbortError'); } });
  await h.session.load(source('current'));
  assert.equal(h.events.filter(([event]) => event === 'error').length, 1);
});

test('close during decode disposes all publication; a reopened player uses a fresh session', async () => {
  const decoding = deferred();
  const h = harness({ loadBlob: () => decoding.promise });
  const pending = h.session.load(source('closing'));
  await tick();
  h.session.dispose();
  decoding.resolve();
  await pending;
  await h.session.load(source('ignored'));
  assert.deepEqual(h.events.map(([event]) => event), ['start']);
  const reopened = harness();
  await reopened.session.load(source('closing'));
  assert.deepEqual(reopened.decoded, ['/closing.wav']);
  assert.equal(reopened.events.at(-1)[0], 'ready');
});

test('buffer is published only after decode, with the same downloaded blob for native playback', async () => {
  const decoding = deferred();
  const blob = new Blob(['one download']);
  let fetchCount = 0;
  const h = harness({ fetchBlob: async () => { fetchCount++; return blob; }, loadBlob: () => decoding.promise });
  const loading = h.session.load(source('voice'));
  await tick();
  assert.deepEqual(h.events.map(([event]) => event), ['start']);
  decoding.resolve(); await loading;
  assert.equal(h.events.at(-1)[2], blob);
  assert.equal(fetchCount, 1);
});

test('progress updates are bounded while seek, pause and finish publish immediately', () => {
  let now = 0;
  const writes = [];
  const publish = createAudioProgressPublisher(time => writes.push(time), () => now);
  for (now = 0; now <= 1000; now += 10) publish(now / 1000);
  assert.equal(writes.length, 11);
  now = 1001; publish(3.5, true); publish(4, true);
  assert.deepEqual(writes.slice(-2), [3.5, 4]);
});

test('identity distinguishes logical clips sharing a URL and ignores a closed source', () => {
  assert.notEqual(audioSourceKey('/same.wav', 'one'), audioSourceKey('/same.wav', 'two'));
  assert.notEqual(audioSourceKey('/old.wav', 'one'), audioSourceKey('/new.wav', 'one'));
  assert.equal(audioSourceKey(null, 'one'), null);
});

test('reopening the same clip retains autoplay until the new media instance is ready', () => {
  const key = audioSourceKey('/voice.wav', 'voice');
  let shouldAutoPlay = true, plays = 0;
  const runPlaybackEffect = (sourceKey, renderedReadyKey, instanceReadyKey) => {
    if (!isAudioReady(sourceKey, renderedReadyKey, instanceReadyKey)) return;
    if (shouldAutoPlay) { shouldAutoPlay = false; plays++; }
  };
  runPlaybackEffect(null, key, null); // close while a previous ready render remains
  runPlaybackEffect(key, key, null); // same source reopens before the new load starts
  runPlaybackEffect(key, null, null); // loading
  assert.equal(shouldAutoPlay, true);
  assert.equal(plays, 0);
  runPlaybackEffect(key, key, key);
  runPlaybackEffect(key, key, key);
  assert.equal(shouldAutoPlay, false);
  assert.equal(plays, 1);
});

test('file fetch validates HTTP and empty files, and reports timeout separately from cancellation', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response('missing', { status: 404 });
    await assert.rejects(fetchAudioBlob('/missing', new AbortController().signal), /404/);
    global.fetch = async () => new Response(new Blob([]));
    await assert.rejects(fetchAudioBlob('/empty', new AbortController().signal), /为空/);
    global.fetch = (_url, { signal }) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    await assert.rejects(fetchAudioBlob('/slow', new AbortController().signal, 10), /超时/);
    const cancel = new AbortController();
    const pending = fetchAudioBlob('/cancel', cancel.signal, 1000);
    cancel.abort();
    await assert.rejects(pending, error => error.name === 'AbortError' && !error.message.includes('超时'));
  } finally { global.fetch = original; }
});

test('media error retires a metadata-stalled instance and a fresh player can load the next clip', async () => {
  const stalled = deferred();
  let listener, removals = 0, retired = 0;
  const order = [];
  const damaged = harness({
    loadBlob: () => prepareAudioInstance(
      () => stalled.promise,
      onError => { listener = onError; return () => { removals++; }; },
      () => { retired++; order.push('retire'); damaged.session.dispose(); },
      1000,
    ).promise,
  });
  const old = damaged.session.load(source('corrupt'));
  await tick();
  // Real WaveSurfer media errors do not settle loadBlob's loadedmetadata wait.
  const queued = damaged.session.load(source('healthy'));
  listener(new Error('Unsupported media'));
  await Promise.all([old, queued]);
  order.push('settled');
  assert.deepEqual(order, ['retire', 'settled']);
  assert.equal(retired, 1);
  assert.equal(removals, 1);
  assert.deepEqual(damaged.fetches, ['/corrupt.wav']);
  assert.equal(damaged.events.some(([event]) => event === 'ready' || event === 'error'), false);
  const fresh = harness();
  await fresh.session.load(source('healthy'));
  stalled.resolve();
  listener(new Error('Old event after destruction'));
  await tick();
  assert.equal(retired, 1);
  assert.equal(fresh.events.at(-1)[1], 'healthy');
  assert.equal(damaged.events.some(([event]) => event === 'ready'), false);
});

test('metadata/decode deadline retires the instance before rejecting and ignores late success', async () => {
  const stalled = deferred();
  const order = [];
  let removals = 0;
  const preparation = prepareAudioInstance(
    () => stalled.promise,
    () => () => { removals++; },
    error => { order.push('retire'); assert.match(error.message, /准备超时/); },
    10,
  );
  await assert.rejects(preparation.promise, /准备超时/);
  order.push('rejected');
  stalled.resolve();
  await tick();
  assert.deepEqual(order, ['retire', 'rejected']);
  assert.equal(removals, 1);
});

test('closing during metadata wait cancels listeners/deadline without retiring or showing an error', async () => {
  const stalled = deferred();
  let listener, removals = 0, retired = 0;
  const preparation = prepareAudioInstance(
    () => stalled.promise,
    onError => { listener = onError; return () => { removals++; }; },
    () => { retired++; },
    10,
  );
  await tick();
  preparation.cancel();
  await assert.rejects(preparation.promise, error => error.name === 'AbortError');
  listener(new Error('Late destroyed-media error'));
  stalled.reject(new Error('Late destroyed-media rejection'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(removals, 1);
  assert.equal(retired, 0);
});

test('successful preparation clears its error subscription and deadline', async () => {
  let removals = 0, retired = 0;
  const preparation = prepareAudioInstance(
    async () => {},
    () => () => { removals++; },
    () => { retired++; },
    10,
  );
  await preparation.promise;
  preparation.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(removals, 1);
  assert.equal(retired, 0);
});

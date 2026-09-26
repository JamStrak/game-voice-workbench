const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'upstream/voicebox/node_modules/typescript'));
function load(relative, mocks = {}) {
  const filename = path.join(root, 'upstream/voicebox/app/src', relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename,
  });
  const result = new Module(filename, module);
  result.filename = filename;
  result.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = result.require.bind(result);
  result.require = name => Object.hasOwn(mocks, name) ? mocks[name] : originalRequire(name);
  result._compile(compiled.outputText, filename);
  return result.exports;
}
const { createGenerationStatusPoller } = load('lib/generation-status-poller.ts');
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { ids: Array.from({ length: 50 }, (_, i) => `task-${i}`), visible: true, calls: [], updates: [] };
  const poller = createGenerationStatusPoller({
    getIds: () => state.ids,
    isVisible: () => state.visible,
    fetchStatuses: async (ids, signal) => {
      state.calls.push({ ids, signal });
      return ids.map(id => ({ id, status: 'generating' }));
    },
    onStatuses: statuses => state.updates.push(statuses),
    ...overrides,
  });
  t.after(() => poller.dispose());
  return { state, poller };
}

test('50 pending jobs share a single short request every two seconds', async t => {
  const { state } = fixture(t);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].ids.length, 50);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(state.calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(state.calls.length, 2);
});

test('slow requests never overlap; a timed-out request is aborted and retried without losing jobs', async t => {
  let running = 0;
  let peak = 0;
  const signals = [];
  const { state, poller } = fixture(t, {
    fetchStatuses: (_ids, signal) => new Promise((_resolve, reject) => {
      signals.push(signal);
      peak = Math.max(peak, ++running);
      signal.addEventListener('abort', () => { running--; reject(new Error('aborted')); }, { once: true });
    }),
  });
  t.mock.timers.tick(0);
  poller.refresh(true);
  t.mock.timers.tick(9000);
  await flush();
  assert.equal(signals.length, 1);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(signals[0].aborted, true);
  // An explicit wake during the previous request is honored only after it ends.
  t.mock.timers.tick(0);
  await flush();
  assert.equal(signals.length, 2);
  assert.equal(peak, 1);
  assert.equal(state.ids.length, 50);
  assert.equal(state.updates.length, 0);
});

test('network errors retain pending jobs and resume after the polling interval', async t => {
  let calls = 0;
  const { state } = fixture(t, {
    fetchStatuses: async ids => {
      calls++;
      if (calls === 1) throw new Error('temporarily offline');
      return ids.map(id => ({ id, status: 'completed' }));
    },
  });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(state.ids.length, 50);
  assert.equal(state.updates.length, 0);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(calls, 2);
  assert.equal(state.updates[0].length, 50);
});

test('hidden tabs abort in-flight requests, ignore late results, and resume immediately without overlap', async t => {
  const requests = [];
  const { state, poller } = fixture(t, {
    fetchStatuses: (ids, signal) => new Promise(resolve => requests.push({ ids, signal, resolve })),
  });
  t.mock.timers.tick(0);
  state.visible = false;
  poller.refresh(true);
  assert.equal(requests[0].signal.aborted, true);
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(requests.length, 1);
  state.visible = true;
  poller.refresh(true);
  t.mock.timers.tick(0);
  assert.equal(requests.length, 1);
  requests[0].resolve([{ id: state.ids[0], status: 'completed' }]);
  await flush();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(state.updates.length, 0);
});

test('empty queues and hidden startup make no requests; new visible work wakes immediately', async t => {
  const { state, poller } = fixture(t);
  state.ids = [];
  poller.refresh();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(state.calls.length, 0);
  state.ids = ['later'];
  state.visible = false;
  poller.refresh();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(state.calls.length, 0);
  state.visible = true;
  poller.refresh(true);
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(state.calls.map(call => call.ids), [['later']]);
});

test('larger queues use sequential batches of at most 100 IDs', async t => {
  const { state } = fixture(t);
  state.ids = Array.from({ length: 250 }, (_, index) => `large-${index}`);
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(state.calls.map(call => call.ids.length), [100, 100, 50]);
  assert.equal(new Set(state.calls.flatMap(call => call.ids)).size, 250);
});

test('unmount aborts the request and never applies a late response or schedules more work', async t => {
  let finish;
  let signal;
  const { state, poller } = fixture(t, {
    fetchStatuses: (_ids, requestSignal) => new Promise(resolve => { signal = requestSignal; finish = resolve; }),
  });
  t.mock.timers.tick(0);
  poller.dispose();
  assert.equal(signal.aborted, true);
  finish([{ id: state.ids[0], status: 'completed' }]);
  await flush();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(state.updates.length, 0);
});

test('batch API forwards the abort signal and sends one JSON POST', async t => {
  const controller = new AbortController();
  const requests = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => [{ id: 'a', status: 'generating' }] };
  });
  const { apiClient } = load('lib/api/client.ts', {
    '@/stores/serverStore': { useServerStore: { getState: () => ({ serverUrl: 'http://localhost:23164' }) } },
  });
  assert.deepEqual(await apiClient.getGenerationStatuses(['a'], controller.signal), [{ id: 'a', status: 'generating' }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:23164/generations/status');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { ids: ['a'] });
  assert.equal(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.cache, 'no-store');
});

test('hook preserves completion, deferred stories, failure, and agent-aware autoplay once per batch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { useGenerationStore: generation } = load('stores/generationStore.ts');
  const { usePlayerStore: player } = load('stores/playerStore.ts');
  const statuses = [
    { id: 'agent', status: 'completed', source: 'mcp' },
    { id: 'story', status: 'completed', duration: 2.5 },
    { id: 'second', status: 'completed' },
    { id: 'failed', status: 'failed', error: 'engine failed' },
    { id: 'missing', status: 'not_found' },
    { id: 'pending', status: 'generating' },
  ];
  statuses.forEach(({ id }) => generation.getState().addPendingGeneration(id));
  generation.getState().addPendingStoryAdd('story', 'project');
  generation.getState().addPendingStoryAdd('failed', 'project');
  const additions = [];
  const toasts = [];
  const refetches = [];
  const invalidations = [];
  const cleanups = [];
  let pollCount = 0;
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const previousDocument = global.document;
  global.document = document;
  t.after(() => {
    cleanups.forEach(cleanup => cleanup());
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  });
  const { useGenerationProgress } = load('lib/hooks/useGenerationProgress.ts', {
    '@tanstack/react-query': { useQueryClient: () => ({ refetchQueries: value => refetches.push(value), invalidateQueries: value => invalidations.push(value) }) },
    react: { useRef: current => ({ current }), useEffect: run => cleanups.push(run()) },
    '@/components/ui/use-toast': { useToast: () => ({ toast: value => toasts.push(value) }) },
    '@/lib/api/client': { apiClient: {
      getGenerationStatuses: async () => { pollCount++; return statuses; },
      addStoryItem: async (...args) => additions.push(args),
      getAudioUrl: id => `/audio/${id}`,
    } },
    '@/lib/generation-status-poller': { createGenerationStatusPoller },
    '@/lib/hooks/useSettings': { useGenerationSettings: () => ({ settings: { autoplay_on_generate: true } }) },
    '@/stores/generationStore': { useGenerationStore: generation },
    '@/stores/playerStore': { usePlayerStore: player },
    '@/stores/serverStore': { useServerStore: selector => selector({ serverUrl: 'http://localhost:23164' }) },
  });
  useGenerationProgress();
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual([...generation.getState().pendingGenerationIds], ['pending']);
  assert.deepEqual(additions, [['project', { generation_id: 'story' }]]);
  assert.equal(generation.getState().pendingStoryAdds.size, 0);
  assert.equal(player.getState().audioId, 'story');
  assert.equal(player.getState().shouldAutoPlay, true);
  assert.equal(refetches.length, 1);
  assert.equal(invalidations.length, 2);
  assert.deepEqual(toasts.map(toast => toast.title).sort(), ['Added to story', 'Generation failed', 'Generation not found']);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(pollCount, 2);
  assert.equal(refetches.length, 1);
  assert.equal(additions.length, 1);
});

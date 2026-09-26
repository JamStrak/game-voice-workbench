// Run from the project root: node --test tests/workbench-data.test.cjs
// Transpile only the pure frontend module; no network, server, or model access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'upstream/voicebox/node_modules/typescript'));
const sourcePath = path.join(root, 'upstream/voicebox/app/src/components/WorkbenchTab/workbench-data.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: sourcePath,
});
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled.outputText, sourcePath);
const { parseScript, lineVersions, exportVersion, isPending, assignRoleVoices, batchPollInterval } = loaded.exports;

function version(id, isDefault = false, effects = undefined) {
  return { id, generation_id: id.split('-')[0], label: id, audio_path: `${id}.wav`,
    is_default: isDefault, effects_chain: effects, created_at: '2026-09-22T00:00:00Z' };
}
function take(id, status, versions) { return { id, status, text: `${id} text`, versions }; }
function line(takes, preferred) {
  return { number: 'A001', role: '守卫', text: '当前台词', profile_id: 'voice-1',
    generations: takes.map(t => t.id), takes, preferred_generation_id: preferred };
}

test('batch polling slows when idle and resumes for loading or generating takes', () => {
  assert.equal(batchPollInterval(undefined), 30000);
  assert.equal(batchPollInterval({ lines: [] }), 30000);
  for (const status of ['completed', 'failed']) {
    assert.equal(batchPollInterval({ lines: [line([take('one', status, [])])] }), 30000);
  }
  for (const status of ['loading_model', 'generating']) {
    assert.equal(batchPollInterval({ lines: [line([take('old', 'completed', []), take('new', status, [])])] }), 2500);
  }
});

test('parseScript trims fields but preserves separators and spaces inside dialogue', () => {
  assert.deepEqual(parseScript('  A001 | 守卫 | 第一段 | 第二段||结尾  '), [
    { number: 'A001', role: '守卫', text: '第一段 | 第二段||结尾' },
  ]);
});

test('parseScript accepts CRLF and ignores blank lines while retaining order', () => {
  assert.deepEqual(parseScript('\r\n A001 | 守卫 | 站住。\r\n \t\r\n B001 | 旅人 | 好的。\r\n'), [
    { number: 'A001', role: '守卫', text: '站住。' },
    { number: 'B001', role: '旅人', text: '好的。' },
  ]);
});

test('parseScript reports original input line numbers and rejects incomplete input', () => {
  assert.throws(() => parseScript('\n\nA001 | 守卫'), /第 3 行/);
  for (const input of ['', ' \r\n\t', '| 守卫 | 台词', 'A001 | | 台词', 'A001 | 守卫 | ']) {
    assert.throws(() => parseScript(input), Error, input);
  }
});

test('parseScript rejects case-insensitive duplicate numbers', () => {
  assert.throws(() => parseScript('A001 | 守卫 | 一\na001 | 旅人 | 二'), /重复/);
});

test('parseScript accepts Chinese numbers and filename-safe punctuation', () => {
  assert.equal(parseScript('第一章_001-A | 守卫 | 站住。')[0].number, '第一章_001-A');
});

test('parseScript rejects unsafe and Windows-reserved numbers', () => {
  for (const number of ['a/b', '../a', 'a.b', 'a b', 'a:b', 'a\\b', 'a*', 'CON', 'prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    assert.throws(() => parseScript(`${number} | 守卫 | 站住。`), /编号不可用/, number);
  }
});

test('parseScript enforces number, role, and dialogue length boundaries', () => {
  assert.equal(parseScript(`${'A'.repeat(50)} | ${'角'.repeat(50)} | ${'词'.repeat(2000)}`).length, 1);
  assert.throws(() => parseScript(`${'A'.repeat(51)} | 守卫 | 站住。`), /编号不可用/);
  assert.throws(() => parseScript(`A001 | ${'角'.repeat(51)} | 站住。`), /过长/);
  assert.throws(() => parseScript(`A001 | 守卫 | ${'词'.repeat(2001)}`), /过长/);
});

test('parseScript allows fifty non-empty lines and rejects fifty-one', () => {
  const script = Array.from({ length: 50 }, (_, i) => `A${i} | 守卫 | 台词`).join('\n\n');
  assert.equal(parseScript(script).length, 50);
  assert.throws(() => parseScript(`${script}\nA50 | 守卫 | 台词`), /最多 50/);
});

test('exportVersion preserves the explicit older satisfied take', () => {
  const row = line([take('old', 'completed', [version('old-raw'), version('old-post', true)]),
    take('new', 'completed', [version('new-raw', true)])], 'old');
  assert.equal(exportVersion(row).id, 'old-post');
});

test('exportVersion uses latest successful take when latest redo failed or is pending', () => {
  for (const status of ['failed', 'generating', 'loading_model']) {
    const row = line([take('old', 'completed', [version('old-raw', true)]),
      take('new', status, [version('new-raw', true)])]);
    assert.equal(exportVersion(row).id, 'old-raw', status);
  }
});

test('exportVersion chooses newest successful default when no valid preference exists', () => {
  for (const preferred of [undefined, 'deleted', 'failed']) {
    const row = line([take('old', 'completed', [version('old-raw', true)]),
      take('new', 'completed', [version('new-raw'), version('new-post', true)]),
      take('failed', 'failed', [version('failed-raw', true)])], preferred);
    assert.equal(exportVersion(row).id, 'new-post');
  }
});

test('exportVersion stays on preferred take and uses its first version if default is absent', () => {
  const row = line([take('old', 'completed', [version('old-raw'), version('old-post')]),
    take('new', 'completed', [version('new-raw', true)])], 'old');
  assert.equal(exportVersion(row).id, 'old-raw');
});

test('exportVersion stays on latest successful take if that take has no marked default', () => {
  const row = line([take('old', 'completed', [version('old-raw', true)]),
    take('new', 'completed', [version('new-raw'), version('new-post')])]);
  assert.equal(exportVersion(row).id, 'new-raw');
});

test('lineVersions includes only completed versions and keeps take numbers and original text', () => {
  const row = line([take('old', 'failed', [version('old-raw', true)]),
    take('new', 'completed', [version('new-raw', true, []), version('new-post', false, [{ type: 'tempo', params: { speed: 1.25 } }])]),
    take('pending', 'generating', [version('pending-raw', true)])]);
  const before = JSON.stringify(row);
  const result = lineVersions(row);
  assert.deepEqual(result.map(v => [v.id, v.generationId, v.takeNumber, v.text]), [
    ['new-raw', 'new', 2, 'new text'], ['new-post', 'new', 2, 'new text'],
  ]);
  assert.deepEqual(result[0].effects_chain, []);
  assert.equal(exportVersion(row).id, 'new-raw');
  assert.equal(JSON.stringify(row), before, 'selection does not rewrite source data');
});

test('no completed audio produces no export version', () => {
  assert.equal(exportVersion(line([])), undefined);
  assert.equal(exportVersion(line([take('failed', 'failed', [version('failed-raw', true)])])), undefined);
  assert.deepEqual(lineVersions(line([take('pending', 'loading_model', [])])), []);
});

test('isPending matches both active backend statuses and no completed/failed status', () => {
  assert.equal(isPending('loading_model'), true);
  assert.equal(isPending('generating'), true);
  for (const status of ['completed', 'failed', undefined]) assert.equal(isPending(status), false);
});

const profiles = [
  { id: 'dylan-processed', preset_voice_id: 'Dylan', effects_chain: [{ type: 'tempo' }] },
  { id: 'serena-processed', preset_voice_id: 'Serena', effects_chain: [{ type: 'gain' }] },
  { id: 'dylan-raw', preset_voice_id: 'Dylan' },
  { id: 'serena-raw', preset_voice_id: 'Serena', effects_chain: [] },
  { id: 'my-voice' },
];

test('assignRoleVoices prefers unprocessed defaults, including empty effects arrays', () => {
  assert.deepEqual(assignRoleVoices(['守卫', '旅人'], profiles, {}), {
    守卫: 'dylan-raw', 旅人: 'serena-raw',
  });
});

test('assignRoleVoices preserves role voices when inserting or reordering script roles', () => {
  const initial = assignRoleVoices(['守卫', '旅人'], profiles, {});
  const inserted = assignRoleVoices(['商人', '守卫', '旅人'], profiles, initial);
  assert.equal(inserted.守卫, initial.守卫);
  assert.equal(inserted.旅人, initial.旅人);
  assert.equal(inserted.商人, 'dylan-raw');
  const reordered = assignRoleVoices(['旅人', '商人', '守卫'], profiles, inserted);
  assert.deepEqual(reordered, inserted);
});

test('assignRoleVoices preserves explicit choices, including an intentionally processed voice', () => {
  const chosen = { 守卫: 'my-voice', 旅人: 'serena-processed' };
  assert.deepEqual(assignRoleVoices(['旅人', '守卫'], profiles, chosen), chosen);
});

test('assignRoleVoices does not mutate saved choices and retains temporarily removed roles', () => {
  const saved = { 守卫: 'my-voice', 旅人: 'serena-raw' };
  const result = assignRoleVoices(['守卫', '商人'], profiles, saved);
  assert.deepEqual(saved, { 守卫: 'my-voice', 旅人: 'serena-raw' });
  assert.equal(result.旅人, 'serena-raw');
  assert.equal(assignRoleVoices(['旅人', '守卫', '商人'], profiles, result).旅人, 'serena-raw');
});

test('assignRoleVoices fills defaults after profiles load without overwriting a manual selection', () => {
  const pending = assignRoleVoices(['守卫', '旅人'], [], { 守卫: 'my-voice' });
  assert.deepEqual(pending, { 守卫: 'my-voice', 旅人: '' });
  assert.deepEqual(assignRoleVoices(['守卫', '旅人'], profiles, pending), {
    守卫: 'my-voice', 旅人: 'serena-raw',
  });
});

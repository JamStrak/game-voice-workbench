const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'upstream/voicebox/node_modules/typescript'));
function load(relative) {
  const filename = path.join(root, relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: filename,
  });
  const result = new Module(filename, module);
  result.filename = filename;
  result.paths = Module._nodeModulePaths(path.dirname(filename));
  result._compile(compiled.outputText, filename);
  return result.exports;
}
const { filterLibraryVoices, roleEffects, upsertProfileList } = load('upstream/voicebox/app/src/lib/voice-library.ts');
const { NATURAL_EXPRESSION, resolveDefaultExpression, expressionFromSelection } = load('upstream/voicebox/app/src/lib/expression.ts');
const angry = { mode: 'manual', emotion: 'angry', intensity: 'medium', instruction: '' };
const sad = { ...angry, emotion: 'sad' };
test('form-select mount events cannot replace a loaded angry role default with calm', () => {
  let current = angry;
  let manualEdits = 0;
  function onValueChange(value) {
    const next = expressionFromSelection(current, value);
    if (next) { current = next; manualEdits += 1; }
  }
  onValueChange('');
  onValueChange('angry');
  onValueChange('not-an-emotion');
  assert.deepEqual(current, angry);
  assert.equal(manualEdits, 0);
  onValueChange('sad');
  assert.deepEqual(current, sad);
  assert.equal(manualEdits, 1);
  onValueChange('natural');
  assert.equal(current.mode, 'natural');
});
const voices = [
  { id: 'a', name: '暖心女声', speaker: 'Serena', description: '温柔的叙事声音', gender: 'female', native_language: 'zh', tags: ['旁白', '向导'] },
  { id: 'b', name: '勇士', speaker: 'Ryan', description: '明亮男声', gender: 'male', native_language: 'en', tags: ['战士', '旁白'] },
];
test('saved role is immediately selectable from an inactive or missing profile cache', () => {
  const existing = [{ id: 'old', name: 'Old voice' }];
  const saved = { id: 'new', name: 'New project role' };
  assert.equal(upsertProfileList(undefined, saved)[0].id, 'new');
  const published = upsertProfileList(existing, saved);
  assert.ok(published.some(profile => profile.id === saved.id));
  assert.ok(published.some(profile => profile.id === 'old'));
  assert.deepEqual(existing, [{ id: 'old', name: 'Old voice' }]);
  const updated = upsertProfileList(published, { ...saved, name: 'Updated role' });
  assert.equal(updated.filter(profile => profile.id === saved.id).length, 1);
  assert.equal(updated.find(profile => profile.id === saved.id).name, 'Updated role');
});
test('voice search combines text, gender, and tags without changing the catalog', () => {
  assert.deepEqual(filterLibraryVoices(voices, '  RYAN  ', 'male', '战士').map(v => v.id), ['b']);
  assert.equal(filterLibraryVoices(voices, '温柔', 'male', '').length, 0);
  assert.equal(filterLibraryVoices(voices, '', '', '旁白').length, 2);
  assert.equal(voices.length, 2);
});
test('project effects omit unchanged values and preserve pitch before independent tempo', () => {
  assert.deepEqual(roleEffects(1, 0), []);
  assert.deepEqual(roleEffects(1.2, -2), [
    { type: 'pitch', enabled: true, params: { semitones: -2 } },
    { type: 'tempo', enabled: true, params: { speed: 1.2 } },
  ]);
});
test('invalid effect parameters never become a silent default', () => {
  for (const [speed, pitch] of [[0.5, 0], [2, 0], [NaN, 0], [1, 5], [1, -5], [1, Infinity]]) {
    assert.throws(() => roleEffects(speed, pitch));
  }
});
test('role expression is inherited unless an explicit batch or sentence override exists', () => {
  assert.deepEqual(resolveDefaultExpression(angry), angry);
  assert.deepEqual(resolveDefaultExpression(angry, sad), sad);
  assert.deepEqual(resolveDefaultExpression(angry, sad, NATURAL_EXPRESSION), NATURAL_EXPRESSION);
  assert.deepEqual(resolveDefaultExpression(angry, NATURAL_EXPRESSION), NATURAL_EXPRESSION);
  assert.deepEqual(resolveDefaultExpression(undefined), NATURAL_EXPRESSION);
  assert.deepEqual(resolveDefaultExpression(angry, undefined, sad), sad);
});

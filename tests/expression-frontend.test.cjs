// Pure UI contract tests. No server, model, or browser is needed.
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
const { NATURAL_EXPRESSION, normalizeExpression, expressionBlockReason, expressionLabel, expressionKey, adoptExpression } =
  load('upstream/voicebox/app/src/lib/expression.ts');
const { exportVersion } = load('upstream/voicebox/app/src/components/WorkbenchTab/workbench-data.ts');
const { isGenerationProfileSupported } = load('upstream/voicebox/app/src/lib/profile-compatibility.ts');
const manual = { mode: 'manual', emotion: 'angry', intensity: 'strong', instruction: '' };
const automatic = { ...manual, mode: 'auto', instruction: '压着怒气说' };

test('legacy batches and missing expression keep natural mode with no model dependency', () => {
  assert.deepEqual(normalizeExpression(undefined), NATURAL_EXPRESSION);
  assert.deepEqual(normalizeExpression(null), NATURAL_EXPRESSION);
  assert.equal(expressionBlockReason(NATURAL_EXPRESSION, undefined), '');
  assert.equal(expressionBlockReason(NATURAL_EXPRESSION, { ready: false, analyzer_ready: false }), '');
});
test('manual overrides and natural mode discard automatic instruction', () => {
  assert.equal(normalizeExpression({ ...manual, instruction: '要悲伤' }).instruction, '');
  assert.equal(normalizeExpression({ ...automatic, mode: 'natural' }).instruction, '');
  assert.equal(normalizeExpression({ ...automatic }).instruction, '压着怒气说');
  assert.equal(normalizeExpression({ ...automatic, instruction: '啊'.repeat(250) }).instruction.length, 200);
});
test('emotion generation fails closed when readiness is absent or false', () => {
  assert.notEqual(expressionBlockReason(manual), '');
  assert.equal(expressionBlockReason(manual, { ready: false, analyzer_ready: true, reason: '模型准备中' }), '模型准备中');
  assert.notEqual(expressionBlockReason(automatic, { ready: true, analyzer_ready: false }), '');
  assert.equal(expressionBlockReason(manual, { ready: true, analyzer_ready: false }), '');
  assert.equal(expressionBlockReason(automatic, { ready: true, analyzer_ready: true }), '');
});
test('adopting a suggestion becomes a durable manual selection without mutating preview inputs', () => {
  const source = { ...automatic };
  const result = adoptExpression(source, { resolved_emotion: 'sad', summary: '悲伤', vector: [], analyzer: 'model' });
  assert.deepEqual(result, { mode: 'manual', emotion: 'sad', intensity: 'strong', instruction: '' });
  assert.deepEqual(source, automatic);
});
test('preview identity changes with text, instruction, mode, and intensity so old suggestions are not shown', () => {
  const key = expressionKey('别走。', automatic);
  assert.notEqual(key, expressionKey('回来吧。', automatic));
  assert.notEqual(key, expressionKey('别走。', { ...automatic, instruction: '开心地说' }));
  assert.notEqual(key, expressionKey('别走。', { ...automatic, intensity: 'light' }));
  assert.notEqual(key, expressionKey('别走。', manual));
});
test('history distinguishes requested automatic analysis from its resolved emotion', () => {
  assert.equal(expressionLabel(undefined), '自然');
  assert.equal(expressionLabel(manual), '愤怒 · 强');
  assert.equal(expressionLabel(automatic), '自动判断 · 强');
  assert.equal(expressionLabel(automatic, { resolved_emotion: 'sad' }), '自动 · 悲伤 · 强');
});
test('audition and export preserve the selected old take expression after newer emotional redo', () => {
  const row = {
    number: 'A001', role: '守卫', text: '回来吧。', profile_id: 'voice', preferred_generation_id: 'old',
    takes: [
      { id: 'old', text: '别走。', status: 'completed', expression: manual,
        expression_result: { resolved_emotion: 'angry', summary: '愤怒', vector: [0, 1], analyzer: 'manual' },
        versions: [{ id: 'old-raw', is_default: true }] },
      { id: 'new', text: '回来吧。', status: 'completed', expression: { ...manual, emotion: 'happy' },
        versions: [{ id: 'new-raw', is_default: true }] },
    ],
  };
  const choice = exportVersion(row);
  assert.equal(choice.id, 'old-raw');
  assert.equal(choice.expression.emotion, 'angry');
  assert.equal(choice.expressionResult.resolved_emotion, 'angry');
  assert.equal(choice.text, '别走。');
});

test('emotion mode permits switching directly between preset and cloned references with either previous engine', () => {
  const preset = { voice_type: 'preset', preset_engine: 'qwen_custom_voice' };
  const cloned = { voice_type: 'cloned' };
  for (const engine of ['qwen_custom_voice', 'qwen']) {
    assert.equal(isGenerationProfileSupported(preset, engine, true), true);
    assert.equal(isGenerationProfileSupported(cloned, engine, true), true);
    assert.equal(isGenerationProfileSupported({}, engine, true), true);
  }
});

test('returning to natural expression restores engine compatibility without changing profile classification', () => {
  const preset = { voice_type: 'preset', preset_engine: 'qwen_custom_voice' };
  const cloned = { voice_type: 'cloned' };
  assert.equal(isGenerationProfileSupported(cloned, 'qwen_custom_voice', true), true);
  assert.equal(isGenerationProfileSupported(cloned, 'qwen_custom_voice', false), false);
  assert.equal(isGenerationProfileSupported(cloned, 'qwen', false), true);
  assert.equal(isGenerationProfileSupported(preset, 'qwen', false), false);
  assert.equal(isGenerationProfileSupported(preset, 'qwen_custom_voice', false), true);
});

test('emotion mode does not silently enable unrelated preset engines or designed profiles', () => {
  assert.equal(isGenerationProfileSupported({ voice_type: 'preset', preset_engine: 'kokoro' }, 'kokoro', true), false);
  assert.equal(isGenerationProfileSupported({ voice_type: 'designed' }, 'qwen', true), false);
  assert.equal(isGenerationProfileSupported({ voice_type: 'preset', preset_engine: 'kokoro' }, 'kokoro', false), true);
  assert.equal(isGenerationProfileSupported({ voice_type: 'designed' }, 'qwen', false), true);
});

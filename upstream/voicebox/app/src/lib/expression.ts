export const EMOTIONS = [
  { value: 'happy', label: '开心' },
  { value: 'angry', label: '愤怒' },
  { value: 'sad', label: '悲伤' },
  { value: 'afraid', label: '恐惧' },
  { value: 'disgusted', label: '厌恶' },
  { value: 'depressed', label: '低落' },
  { value: 'surprised', label: '惊讶' },
  { value: 'calm', label: '平静' },
] as const;

export type Emotion = (typeof EMOTIONS)[number]['value'];
export type ExpressionIntensity = 'light' | 'medium' | 'strong';
export interface Expression {
  mode: 'natural' | 'auto' | 'manual';
  emotion: Emotion;
  intensity: ExpressionIntensity;
  instruction: string;
}
export interface ExpressionResult {
  resolved_emotion: Emotion;
  summary: string;
  vector: number[];
  analyzer: string;
}
export interface ExpressionAnalysis extends ExpressionResult {
  expression: Expression;
}
export interface ExpressionCapabilities {
  ready: boolean;
  analyzer_ready: boolean;
  reason?: string;
}
export const NATURAL_EXPRESSION: Expression = {
  mode: 'natural',
  emotion: 'calm',
  intensity: 'medium',
  instruction: '',
};
export const INTENSITY_LABELS: Record<ExpressionIntensity, string> = {
  light: '轻',
  medium: '适中',
  strong: '强',
};

/** Old batches have no expression. Never upgrade those to a different engine. */
export function normalizeExpression(value?: Partial<Expression> | null): Expression {
  const mode = value?.mode === 'auto' || value?.mode === 'manual' ? value.mode : 'natural';
  return {
    mode,
    emotion: EMOTIONS.some((item) => item.value === value?.emotion) ? value!.emotion! : 'calm',
    intensity:
      value?.intensity === 'light' || value?.intensity === 'strong' ? value.intensity : 'medium',
    instruction:
      mode === 'auto' && typeof value?.instruction === 'string'
        ? value.instruction.slice(0, 200)
        : '',
  };
}

/** Explicit line and batch choices, including natural, take priority over role defaults. */
export function resolveDefaultExpression(
  profileDefault?: Partial<Expression> | null,
  batchOverride?: Partial<Expression> | null,
  lineOverride?: Partial<Expression> | null,
): Expression {
  return normalizeExpression(lineOverride ?? batchOverride ?? profileDefault);
}

/** Radix's hidden form select may emit an empty value while options are mounting. */
export function expressionFromSelection(value: Expression, selected: string): Expression | null {
  const current = normalizeExpression(value);
  const currentSelection = current.mode === 'manual' ? current.emotion : current.mode;
  if (selected === currentSelection) return null;
  if (selected === 'natural' || selected === 'auto')
    return normalizeExpression({ ...current, mode: selected });
  const emotion = EMOTIONS.find((item) => item.value === selected)?.value;
  return emotion ? normalizeExpression({ ...current, mode: 'manual', emotion }) : null;
}
export function emotionLabel(emotion?: string): string {
  return EMOTIONS.find((item) => item.value === emotion)?.label || '未识别';
}
export function expressionLabel(
  value?: Expression | null,
  result?: ExpressionResult | null,
): string {
  const expression = normalizeExpression(value);
  if (expression.mode === 'natural') return '自然';
  const name =
    expression.mode === 'auto'
      ? result?.resolved_emotion
        ? `自动 · ${emotionLabel(result.resolved_emotion)}`
        : '自动判断'
      : emotionLabel(expression.emotion);
  return `${name} · ${INTENSITY_LABELS[expression.intensity]}`;
}
export function expressionBlockReason(
  expression: Expression,
  capabilities?: ExpressionCapabilities,
): string {
  if (expression.mode === 'natural') return '';
  if (!capabilities) return '正在确认情绪配音是否就绪，暂不能生成此表达。';
  if (!capabilities.ready) return capabilities.reason || '情绪配音尚未准备完成，请先使用自然表达。';
  if (expression.mode === 'auto' && !capabilities.analyzer_ready)
    return '自动情绪判断尚未就绪，请手动指定表达方式。';
  return '';
}
export function expressionKey(text: string, expression: Expression): string {
  return JSON.stringify([text, normalizeExpression(expression)]);
}

/** Adopting a suggestion is an explicit manual override, independent of a later analysis. */
export function adoptExpression(expression: Expression, result: ExpressionResult): Expression {
  return normalizeExpression({
    ...expression,
    mode: 'manual',
    emotion: result.resolved_emotion,
    instruction: '',
  });
}

import { AlertCircle, Check, Loader2, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import {
  EMOTIONS,
  INTENSITY_LABELS,
  adoptExpression,
  emotionLabel,
  expressionBlockReason,
  expressionKey,
  expressionFromSelection,
  normalizeExpression,
  type Expression,
  type ExpressionAnalysis,
  type ExpressionIntensity,
} from '@/lib/expression';
import { useExpressionCapabilities } from '@/lib/hooks/useExpression';

export function ExpressionSettings({
  value,
  text,
  onChange,
  disabled = false,
  label = '表达方式',
  showPreview = true,
}: {
  value: Expression;
  text: string;
  onChange: (value: Expression) => void;
  disabled?: boolean;
  label?: string;
  showPreview?: boolean;
}) {
  const id = useId();
  const capabilities = useExpressionCapabilities();
  const [analysis, setAnalysis] = useState<{ key: string; result: ExpressionAnalysis } | null>(
    null,
  );
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const expression = normalizeExpression(value);
  const key = expressionKey(text, expression);
  const preview = analysis?.key === key ? analysis.result : null;
  const blockReason = expressionBlockReason(expression, capabilities.data);
  const unavailable = capabilities.isError
    ? '暂时无法读取情绪配音状态，请检查服务后重试。'
    : blockReason;
  const selection = expression.mode === 'manual' ? expression.emotion : expression.mode;
  const update = (next: Partial<Expression>) => {
    setError('');
    onChange(normalizeExpression({ ...expression, ...next }));
  };
  async function analyze() {
    setError('');
    setAnalyzing(true);
    try {
      const result = await apiClient.analyzeExpression(text, expression);
      setAnalysis({ key, result });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '分析未完成，请重试。');
    } finally {
      setAnalyzing(false);
    }
  }
  return (
    <div className="space-y-3" data-testid="expression-settings">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,0.55fr)] gap-3">
        <div className="space-y-2">
          <Label htmlFor={`${id}-mode`} className="text-xs">
            {label}
          </Label>
          <Select
            value={selection}
            disabled={disabled}
            onValueChange={(selected) => {
              const next = expressionFromSelection(expression, selected);
              if (!next) return;
              setError('');
              onChange(next);
            }}
          >
            <SelectTrigger id={`${id}-mode`} aria-label={label} className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="natural">自然 · 保持原本表达</SelectItem>
              <SelectItem value="auto">自动 · 根据台词判断</SelectItem>
              {EMOTIONS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-intensity`} className="text-xs">
            情绪强度
          </Label>
          <Select
            value={expression.intensity}
            disabled={disabled || expression.mode === 'natural'}
            onValueChange={(intensity) => {
              if (
                intensity === expression.intensity ||
                !Object.keys(INTENSITY_LABELS).includes(intensity)
              )
                return;
              update({ intensity: intensity as ExpressionIntensity });
            }}
          >
            <SelectTrigger
              id={`${id}-intensity`}
              aria-label={`${label}强度`}
              className="h-9 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(INTENSITY_LABELS).map(([level, title]) => (
                <SelectItem key={level} value={level}>
                  {title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {expression.mode === 'natural' ? (
        <p className="text-xs leading-5 text-muted-foreground">
          沿用声音档案的自然表达。选择具体情绪，可以重新演绎这句台词。
        </p>
      ) : expression.mode === 'auto' ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-instruction`} className="text-xs">
              情绪说明 <span className="font-normal text-muted-foreground">· 可选</span>
            </Label>
            <Textarea
              id={`${id}-instruction`}
              value={expression.instruction}
              maxLength={200}
              disabled={disabled}
              onChange={(event) => update({ instruction: event.target.value })}
              className="min-h-16 text-xs leading-5"
              placeholder="例如：这句道歉带着愤怒，不是悲伤。"
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            默认根据台词提出建议；填写情绪说明时，优先按说明判断。手动选择始终优先。
          </p>
          {showPreview && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  disabled || analyzing || !text.trim() || !capabilities.data?.analyzer_ready
                }
                onClick={() => void analyze()}
              >
                {analyzing ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {analyzing ? '正在分析…' : '预览情绪建议'}
              </Button>
              {!text.trim() && <span className="text-xs text-muted-foreground">先填写台词</span>}
            </div>
          )}
          {preview && (
            <div
              className="space-y-2 rounded-lg border border-accent/20 bg-accent/5 p-3"
              aria-live="polite"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">
                  建议：{emotionLabel(preview.resolved_emotion)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={disabled}
                  onClick={() => onChange(adoptExpression(expression, preview))}
                >
                  <Check />
                  采用为手动设置
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">{preview.summary}</p>
            </div>
          )}
        </>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          按「{emotionLabel(expression.emotion)}
          」演绎，自动判断不会覆盖你的选择。改变情绪需要重新生成，旧版本会保留。
        </p>
      )}
      {expression.mode !== 'natural' && unavailable && (
        <output className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-xs leading-5">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>{unavailable}</span>
        </output>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

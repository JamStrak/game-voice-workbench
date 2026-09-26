import type { GenerationVersionResponse } from '@/lib/api/types';
import type { Expression, ExpressionResult } from '@/lib/expression';

export function assignRoleVoices(
  roles: string[],
  profiles: { id: string; preset_voice_id?: string; effects_chain?: unknown[] }[],
  existing: Record<string, string>,
): Record<string, string> {
  const voices = { ...existing };
  roles.forEach((role, index) => {
    if (!voices[role]) {
      voices[role] =
        profiles.find(
          (profile) =>
            profile.preset_voice_id === (index % 2 ? 'Serena' : 'Dylan') &&
            !profile.effects_chain?.length,
        )?.id ||
        profiles[0]?.id ||
        '';
    }
  });
  return voices;
}

export interface ScriptLine {
  number: string;
  role: string;
  text: string;
}
export interface Take {
  id: string;
  text: string;
  status: string;
  error?: string;
  expression?: Expression | null;
  expression_result?: ExpressionResult | null;
  versions: GenerationVersionResponse[];
}
export interface BatchLine extends ScriptLine {
  expression?: Expression | null;
  profile_id: string;
  generations: string[];
  preferred_generation_id?: string;
  takes: Take[];
}
export interface BatchSummary {
  id: string;
  title: string;
  lines: ScriptLine[];
}
export interface BatchDetail extends BatchSummary {
  lines: BatchLine[];
}
export type VersionChoice = GenerationVersionResponse & {
  generationId: string;
  takeNumber: number;
  text: string;
  expression?: Expression | null;
  expressionResult?: ExpressionResult | null;
};

export const isPending = (status?: string) => status === 'generating' || status === 'loading_model';

/** Keep live progress responsive; idle batches only need cross-window discovery. */
export function batchPollInterval(batch?: BatchDetail): number {
  return batch?.lines.some((line) => line.takes.some((take) => isPending(take.status)))
    ? 2500
    : 30000;
}

export function parseScript(script: string): ScriptLine[] {
  const lines = script
    .split(/\r?\n/)
    .map((text, index) => ({ text, index }))
    .filter((line) => line.text.trim());
  if (!lines.length) throw new Error('请先输入台词，每行填写「编号 | 角色 | 台词」。');
  if (lines.length > 50) throw new Error('每个批次最多 50 条台词，请分成多个批次。');
  const numbers = new Set<string>();
  return lines.map(({ text, index }) => {
    const [rawNumber, rawRole, ...rest] = text.split('|');
    const number = rawNumber.trim();
    const role = rawRole?.trim();
    const content = rest.join('|').trim();
    if (!number || !role || !content)
      throw new Error(`第 ${index + 1} 行不完整，请填写「编号 | 角色 | 台词」。`);
    if (
      !/^[\p{L}\p{N}_-]{1,50}$/u.test(number) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(number)
    ) {
      throw new Error(
        `第 ${index + 1} 行编号不可用，请使用文字、数字、下划线或短横线，避开系统保留名称。`,
      );
    }
    if (numbers.has(number.toLowerCase()))
      throw new Error(`编号 ${number} 重复，请为每条台词使用不同编号。`);
    if (role.length > 50 || content.length > 2000)
      throw new Error(`第 ${index + 1} 行过长：角色最多 50 字，台词最多 2000 字。`);
    numbers.add(number.toLowerCase());
    return { number, role, text: content };
  });
}

export function lineVersions(line: BatchLine): VersionChoice[] {
  return line.takes.flatMap((take, i) =>
    take.status === 'completed'
      ? take.versions.map((version) => ({
          ...version,
          generationId: take.id,
          takeNumber: i + 1,
          text: take.text,
          expression: take.expression,
          expressionResult: take.expression_result,
        }))
      : [],
  );
}

/** Mirrors export: preferred successful take, otherwise newest successful take. */
export function exportVersion(line: BatchLine): VersionChoice | undefined {
  const versions = lineVersions(line);
  const preferred = versions.find((v) => v.generationId === line.preferred_generation_id);
  const generationId = preferred?.generationId ?? versions[versions.length - 1]?.generationId;
  const candidates = versions.filter((v) => v.generationId === generationId);
  return candidates.find((v) => v.is_default) ?? candidates[0];
}

export async function request<T>(base: string, path: string, data?: unknown): Promise<T> {
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    const detail = error?.detail;
    throw new Error(
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((item: { msg: string }) => item.msg).join('；')
          : `请求未完成（${response.status}），请稍后重试。`,
    );
  }
  return response.json();
}

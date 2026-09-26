import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Download,
  FileAudio,
  FolderOpen,
  ListOrdered,
  Loader2,
  Mic,
  Pause,
  PencilLine,
  Play,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  Star,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ExpressionSettings } from '@/components/Generation/ExpressionSettings';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import type { GenerationVersionResponse, VoiceProfileResponse } from '@/lib/api/types';
import {
  NATURAL_EXPRESSION,
  expressionBlockReason,
  expressionKey,
  expressionLabel,
  normalizeExpression,
  resolveDefaultExpression,
  type Expression,
} from '@/lib/expression';
import { useExpressionCapabilities } from '@/lib/hooks/useExpression';
import { useProfiles } from '@/lib/hooks/useProfiles';
import { cn } from '@/lib/utils/cn';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import {
  type BatchDetail,
  type BatchLine,
  type BatchSummary,
  assignRoleVoices,
  batchPollInterval,
  exportVersion,
  isPending,
  lineVersions,
  parseScript,
  request,
} from './workbench-data';

const EXAMPLE = `A001 | 守卫 | 站住，前方是禁区，请出示你的通行证。
A002 | 守卫 | 天快黑了，路上小心。
A003 | 守卫 | 城门已经打开，祝你一路顺风。
B001 | 旅人 | 我从南方来，想找一位老朋友。
B002 | 旅人 | 谢谢提醒，我会在日落之前回来。
B003 | 旅人 | 准备好了，我们出发吧。`;
const DRAFT_KEY = 'voicebox-dialogue-draft-v1';
const emptyDraft = {
  title: '',
  script: '',
  voices: {} as Record<string, string>,
  expression: { ...NATURAL_EXPRESSION },
  expressionSource: 'profile' as 'profile' | 'batch',
  expressions: {} as Record<string, Expression>,
};
type LineDraft = {
  text: string;
  profileId: string;
  expression: Expression;
  expressionEdited?: boolean;
};
function lineDraft(row: BatchLine): LineDraft {
  return {
    text: row.text,
    profileId: row.profile_id,
    expression: normalizeExpression(row.expression),
  };
}
function readDraft(): typeof emptyDraft {
  try {
    const data = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
    return data && typeof data.title === 'string' && typeof data.script === 'string'
      ? {
          title: data.title,
          script: data.script,
          voices: data.voices && typeof data.voices === 'object' ? data.voices : {},
          expression: normalizeExpression(data.expression),
          expressionSource: data.expressionSource === 'profile' ? 'profile' : 'batch',
          expressions:
            data.expressions && typeof data.expressions === 'object'
              ? Object.fromEntries(
                  Object.entries(data.expressions).map(([key, value]) => [
                    key,
                    normalizeExpression(value as Partial<Expression>),
                  ]),
                )
              : {},
        }
      : emptyDraft;
  } catch {
    return emptyDraft;
  }
}

function VoiceSelect({
  value,
  profiles,
  label,
  onChange,
}: {
  value: string;
  profiles: VoiceProfileResponse[];
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="min-w-0">
        <SelectValue placeholder="选择声音档案" />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function WorkbenchTab() {
  const base = useServerStore((s) => s.serverUrl);
  const expressionCapabilities = useExpressionCapabilities();
  const { data: profileData = [], error: profileError } = useProfiles();
  const profiles = useMemo(
    () =>
      [...profileData].sort(
        (a, b) => Number(!!a.effects_chain?.length) - Number(!!b.effects_chain?.length),
      ),
    [profileData],
  );
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const hasPlayer = usePlayerStore((s) => !!s.audioUrl);
  const [selectedId, setSelectedId] = useState(() => {
    try {
      return sessionStorage.getItem('voicebox-dialogue-selected-batch') || '';
    } catch {
      return '';
    }
  });
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const [draft, setDraft] = useState(readDraft);
  const [creationError, setCreationError] = useState('');
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState('');
  // Keep unsaved edits across batch changes and polling, without replacing server data.
  const [edits, setEdits] = useState<Record<string, LineDraft>>({});
  const batches = useQuery({
    queryKey: ['dialogue-batches', base],
    queryFn: () => request<BatchSummary[]>(base, '/local/batches'),
    staleTime: 10000,
    refetchInterval: 30000,
  });
  const batchId = batches.data?.some((item) => item.id === selectedId)
    ? selectedId
    : batches.data?.[0]?.id || '';
  const detail = useQuery({
    queryKey: ['dialogue-batch', base, batchId],
    queryFn: () => request<BatchDetail>(base, `/local/batches/${batchId}`),
    enabled: !!batchId,
    refetchInterval: (query) => batchPollInterval(query.state.data),
  });
  const models = useQuery({
    queryKey: ['dialogue-models', base],
    queryFn: () => request<{ models: { downloaded: boolean }[] }>(base, '/models/status'),
    staleTime: 30000,
    refetchInterval: 60000,
  });
  const batch = detail.data;
  const rows = batch?.lines || [];
  const roles = [...new Set(rows.map((row) => row.role))];
  const completeCount = rows.filter((row) => exportVersion(row)).length;
  const pendingCount = rows.filter((row) =>
    row.takes.some((take) => isPending(take.status)),
  ).length;
  const visible = rows.filter(
    (row) =>
      (!role || row.role === role) &&
      `${row.number} ${row.role} ${row.text}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const parsed = useMemo(() => {
    try {
      return { lines: parseScript(draft.script), error: '' };
    } catch (error) {
      return { lines: [], error: (error as Error).message };
    }
  }, [draft.script]);
  const draftRoles = [...new Set(parsed.lines.map((line) => line.role))];
  const voiceFor = (name: string) => draft.voices[name] || '';
  const expressionFor = (number: string) => {
    const line = parsed.lines.find((item) => item.number === number);
    const profile = profiles.find((item) => item.id === voiceFor(line?.role || ''));
    return resolveDefaultExpression(
      profile?.default_expression,
      draft.expressionSource === 'batch' ? draft.expression : undefined,
      draft.expressions[number],
    );
  };
  const creationBlocked =
    parsed.lines
      .map((line) =>
        expressionBlockReason(
          expressionFor(line.number),
          expressionCapabilities.isError ? undefined : expressionCapabilities.data,
        ),
      )
      .find(Boolean) || '';

  useEffect(() => {
    if (!profiles.length || !parsed.lines.length) return;
    setDraft((previous) => {
      const voices = assignRoleVoices(
        [...new Set(parsed.lines.map((line) => line.role))],
        profiles,
        previous.voices,
      );
      return Object.keys(voices).some((name) => voices[name] !== previous.voices[name])
        ? { ...previous, voices }
        : previous;
    });
  }, [parsed.lines, profiles]);

  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* Draft still remains in memory. */
    }
  }, [draft]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed batch is the reset event for these view filters.
  useEffect(() => {
    setRole('');
    setSearch('');
    setExpanded('');
  }, [batchId]);
  useEffect(() => {
    if (batchId) {
      try {
        sessionStorage.setItem('voicebox-dialogue-selected-batch', batchId);
      } catch {
        /* Optional navigation state. */
      }
    }
  }, [batchId]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dialogue-batch', base, batchId] }),
      queryClient.invalidateQueries({ queryKey: ['dialogue-batches', base] }),
      queryClient.invalidateQueries({ queryKey: ['history'] }),
    ]);
  }
  async function act(fn: () => Promise<void>, message: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setActionError('');
    try {
      await fn();
      await refresh();
      toast({ title: message });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作未完成，请重试。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function createBatch() {
    if (creating) return;
    setCreationError('');
    if (parsed.error) {
      setCreationError(parsed.error);
      return;
    }
    if (!draft.title.trim()) {
      setCreationError('请为这组台词填写一个名称。');
      return;
    }
    const lines = parsed.lines.map((line) => ({
      ...line,
      profile_id: voiceFor(line.role),
      expression: expressionFor(line.number),
    }));
    if (creationBlocked) {
      setCreationError(creationBlocked);
      return;
    }
    if (lines.some((line) => !profiles.some((profile) => profile.id === line.profile_id))) {
      setCreationError('请为每个角色选择可用的声音档案。');
      return;
    }
    setCreating(true);
    try {
      const result = await request<BatchSummary>(base, '/local/batches', {
        title: draft.title.trim(),
        lines,
      });
      await queryClient.invalidateQueries({ queryKey: ['dialogue-batches', base] });
      setSelectedId(result.id);
      setOpen(false);
      setDraft(emptyDraft);
      toast({ title: '台词已加入生成队列', description: '可以随时停止，已完成的声音会保留。' });
    } catch (error) {
      setCreationError((error as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const error =
    actionError || detail.error?.message || batches.error?.message || profileError?.message;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="dialogue-workbench">
      <header className="flex flex-wrap items-center justify-between gap-4 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">角色台词</h1>
            <span className="border-l border-border pl-3 text-sm font-medium text-muted-foreground">
              Voicebox
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">分配声音，逐句打磨，按编号交付。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/voices">
              <Mic />
              声音档案
            </Link>
          </Button>
          <Button
            onClick={() => {
              setCreationError('');
              setOpen(true);
            }}
          >
            <Plus />
            新建批次
          </Button>
        </div>
      </header>
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="flex-1">{error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setActionError('');
              void refresh();
            }}
          >
            重试
          </Button>
        </div>
      )}
      <div
        className={cn('flex min-h-0 flex-1 flex-col gap-6 pb-6 lg:flex-row', hasPlayer && 'pb-36')}
      >
        <aside
          aria-label="台词批次"
          className="flex shrink-0 flex-col gap-3 lg:w-56 lg:border-r lg:border-border lg:pr-5"
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>我的批次</span>
            <span>{batches.data?.length || 0} 组</span>
          </div>
          <div className="flex gap-2 overflow-auto pb-1 lg:flex-1 lg:flex-col lg:justify-start lg:pb-0">
            {batches.isLoading ? (
              <p className="p-3 text-sm text-muted-foreground">正在载入批次…</p>
            ) : (
              batches.data?.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={batchId === item.id}
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    'flex shrink-0 items-start gap-3 rounded-lg border p-3 text-left transition-colors lg:w-full',
                    batchId === item.id
                      ? 'border-accent/40 bg-accent/10'
                      : 'border-transparent hover:bg-muted/60',
                  )}
                >
                  <FolderOpen
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      batchId === item.id ? 'text-accent' : 'text-muted-foreground',
                    )}
                  />
                  <div className="min-w-0">
                    <div className="max-w-48 truncate text-sm font-medium" title={item.title}>
                      {item.title}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.lines.length} 条台词 ·{' '}
                      {new Set(item.lines.map((line) => line.role)).size} 个角色
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="hidden border-t border-border pt-4 text-xs leading-6 text-muted-foreground lg:block">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  models.data?.models.every((model) => model.downloaded)
                    ? 'bg-accent'
                    : 'bg-muted-foreground',
                )}
              />
              {models.error
                ? '模型状态暂不可用'
                : models.data?.models.every((model) => model.downloaded)
                  ? '本地模型已就绪'
                  : models.isLoading
                    ? '检查模型中…'
                    : '部分模型未就绪'}
            </span>
            参考录音保存在声音档案中。
            <br />
            成品导出仅包含音频与台词清单。
          </div>
        </aside>
        <section aria-label="批次内容" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!batchId && !batches.isLoading ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
              <ListOrdered className="mb-4 h-10 w-10 text-accent" />
              <h2 className="text-lg font-semibold">让每个角色拥有自己的声音</h2>
              <p className="mb-6 mt-2 text-sm text-muted-foreground">
                新建一组台词，分配声音后即可批量生成。
              </p>
              <Button onClick={() => setOpen(true)}>
                <Plus />
                新建批次
              </Button>
            </div>
          ) : !batch ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在载入台词…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 pb-4">
                <div className="min-w-0">
                  <h2 className="break-words text-lg font-semibold">{batch.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {rows.length} 条台词 <span className="px-1.5">·</span> {roles.length} 个角色{' '}
                    <span className="px-1.5">·</span> {completeCount} 条可导出
                    {pendingCount > 0 && (
                      <span className="ml-2 text-accent">{pendingCount} 条等待 / 生成中</span>
                    )}
                  </p>
                </div>
                <div className="flex gap-2">
                  {pendingCount > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await request(base, `/local/batches/${batchId}/cancel`, {});
                        }, '已停止未完成台词，已完成结果保留')
                      }
                    >
                      <Square />
                      停止生成
                    </Button>
                  )}
                  {completeCount > 0 ? (
                    <Button size="sm" variant="outline" asChild>
                      <a href={`${base}/local/batches/${batchId}/export`} download>
                        <Download />
                        导出 {completeCount} 条
                      </a>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>
                      <Download />
                      导出音频
                    </Button>
                  )}
                </div>
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-2 border-y border-border py-3">
                <fieldset className="flex min-w-0 flex-1 flex-wrap gap-1" aria-label="按角色筛选">
                  <Button
                    size="sm"
                    variant={!role ? 'secondary' : 'ghost'}
                    onClick={() => setRole('')}
                    aria-pressed={!role}
                  >
                    全部角色
                  </Button>
                  {roles.map((name) => (
                    <Button
                      key={name}
                      size="sm"
                      variant={role === name ? 'secondary' : 'ghost'}
                      onClick={() => setRole(name)}
                      aria-pressed={role === name}
                    >
                      {name}
                    </Button>
                  ))}
                </fieldset>
                <div className="relative w-full sm:w-52">
                  <Search className="absolute left-3 top-3 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    className="h-9 rounded-full pl-9"
                    aria-label="搜索台词"
                    placeholder="搜索编号、角色或台词"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
              </div>
              <section
                className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-4"
                aria-label="台词列表"
              >
                {visible.map((row) => {
                  const key = `${batchId}/${row.number}`;
                  return (
                    <LineCard
                      key={key}
                      row={row}
                      profiles={profiles}
                      base={base}
                      busy={busy}
                      expanded={expanded === key}
                      onExpand={() => setExpanded(expanded === key ? '' : key)}
                      draft={edits[key] || lineDraft(row)}
                      onEdit={(edit) => setEdits((prev) => ({ ...prev, [key]: edit }))}
                      onRedo={() =>
                        void act(async () => {
                          const edit = edits[key] || lineDraft(row);
                          if (!edit.text.trim()) throw new Error('台词内容不能为空。');
                          await request(
                            base,
                            `/local/batches/${batchId}/redo/${encodeURIComponent(row.number)}`,
                            {
                              number: row.number,
                              role: row.role,
                              text: edit.text.trim(),
                              profile_id: edit.profileId,
                              expression: normalizeExpression(edit.expression),
                            },
                          );
                          setEdits((prev) => {
                            if (
                              prev[key] &&
                              (prev[key].text !== edit.text ||
                                prev[key].profileId !== edit.profileId ||
                                expressionKey('', prev[key].expression) !==
                                  expressionKey('', edit.expression))
                            )
                              return prev;
                            const next = { ...prev };
                            delete next[key];
                            return next;
                          });
                        }, '已加入重做队列，旧版本保留')
                      }
                      onSelect={(generationId, versionId) =>
                        void act(async () => {
                          await request(
                            base,
                            `/local/batches/${batchId}/select/${encodeURIComponent(row.number)}`,
                            { generation_id: generationId, version_id: versionId },
                          );
                        }, '已设为满意版本，导出将使用这版声音')
                      }
                      onProcess={(generationId, sourceId, speed, gain) =>
                        void act(async () => {
                          if (
                            !Number.isFinite(speed) ||
                            speed < 0.5 ||
                            speed > 2 ||
                            !Number.isFinite(gain) ||
                            gain < -40 ||
                            gain > 40
                          )
                            throw new Error('语速范围为 0.5–2 倍，音量范围为 -40–40 dB。');
                          const processed = await request<GenerationVersionResponse>(
                            base,
                            `/generations/${generationId}/versions/apply-effects`,
                            {
                              source_version_id: sourceId,
                              effects_chain: [
                                { type: 'tempo', params: { speed } },
                                { type: 'gain', params: { gain_db: gain } },
                              ],
                              label: `${speed}x / ${gain}dB`,
                              set_as_default: true,
                            },
                          );
                          await request(
                            base,
                            `/local/batches/${batchId}/select/${encodeURIComponent(row.number)}`,
                            { generation_id: generationId, version_id: processed.id },
                          );
                        }, '后期版本已保存并用于导出，原声保留')
                      }
                    />
                  );
                })}
                {!visible.length && (
                  <p className="py-14 text-center text-sm text-muted-foreground">
                    没有匹配的台词。试试其他关键词或切换到全部角色。
                  </p>
                )}
              </section>
              <p className="pt-2 text-xs text-muted-foreground">
                导出使用每条台词的满意版本；未指定时使用最近成功生成的版本。
              </p>
            </>
          )}
        </section>
      </div>

      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!creating) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>新建台词批次</DialogTitle>
            <DialogDescription>粘贴台词，为每个角色分配声音，然后逐条生成。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_240px]">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="batch-title">批次名称</Label>
                <Input
                  id="batch-title"
                  maxLength={100}
                  placeholder="例如：第一章 · 城门对话"
                  value={draft.title}
                  disabled={creating}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="batch-script">台词内容</Label>
                  <Button
                    variant="link"
                    size="sm"
                    disabled={!!draft.script.trim() || creating}
                    onClick={() =>
                      setDraft({ ...draft, title: draft.title || '游戏角色试音', script: EXAMPLE })
                    }
                  >
                    填入示例
                  </Button>
                </div>
                <Textarea
                  id="batch-script"
                  className="min-h-64 resize-y leading-7"
                  placeholder={'A001 | 守卫 | 站住，请出示通行证。\nB001 | 旅人 | 我从南方来。'}
                  value={draft.script}
                  disabled={creating}
                  onChange={(event) => {
                    setDraft({ ...draft, script: event.target.value });
                    setCreationError('');
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  每行：编号 | 角色 | 台词 · 最多 50 条 · 编号不能重复
                </p>
              </div>
              {draft.script.trim() && parsed.error && (
                <output className="block text-sm text-destructive">{parsed.error}</output>
              )}
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-accent" />
                角色声音
              </h3>
              <p className="mb-5 text-xs leading-5 text-muted-foreground">
                使用与单条配音相同的声音档案。
              </p>
              <div className="space-y-4">
                {draftRoles.map((name) => (
                  <div key={name} className="space-y-2">
                    <p className="flex items-center justify-between text-sm">
                      <span>{name}</span>
                      <span className="text-xs text-muted-foreground">
                        {parsed.lines.filter((line) => line.role === name).length} 条
                      </span>
                    </p>
                    <VoiceSelect
                      label={`${name}的声音`}
                      profiles={profiles}
                      value={voiceFor(name)}
                      onChange={(value) =>
                        setDraft({ ...draft, voices: { ...draft.voices, [name]: value } })
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      角色默认：
                      {expressionLabel(
                        profiles.find((profile) => profile.id === voiceFor(name))
                          ?.default_expression,
                      )}
                    </p>
                  </div>
                ))}
                {!draftRoles.length && (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    输入台词后，角色会显示在这里。
                  </p>
                )}
              </div>
              <p className="mt-6 border-t border-border pt-3 text-xs leading-5 text-muted-foreground">
                沿用角色保存的语速、音高和表达设置。每句仍可单独调整。
              </p>
              {!profiles.length && (
                <Button asChild variant="link" className="mt-2">
                  <Link to="/voices">先创建声音档案</Link>
                </Button>
              )}
            </div>
          </div>
          <section
            className="space-y-4 rounded-lg border border-border bg-card p-4"
            aria-label="台词表达设置"
          >
            <div className="space-y-2">
              <Label htmlFor="batch-expression-source">表达设置</Label>
              <Select
                value={draft.expressionSource}
                disabled={creating}
                onValueChange={(value) =>
                  setDraft((previous) => ({
                    ...previous,
                    expressionSource: value as 'profile' | 'batch',
                  }))
                }
              >
                <SelectTrigger id="batch-expression-source" aria-label="批次表达来源">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="profile">使用每个角色的默认表达</SelectItem>
                  <SelectItem value="batch">为本批次统一设置表达</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.expressionSource === 'batch' ? (
              <ExpressionSettings
                label="批次默认表达"
                value={draft.expression}
                text=""
                showPreview={false}
                disabled={creating}
                onChange={(expression) => setDraft((previous) => ({ ...previous, expression }))}
              />
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                每个角色沿用「我的声音」中保存的默认情绪；单句手动设置始终优先。
              </p>
            )}
            {!!parsed.lines.length && (
              <details className="border-t border-border pt-3">
                <summary className="cursor-pointer text-xs font-medium">
                  逐句预览与调整{' '}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {parsed.lines.length} 条 · 单句设置优先
                  </span>
                </summary>
                <div className="mt-3 max-h-96 space-y-3 overflow-y-auto pr-1">
                  {parsed.lines.map((line) => (
                    <details key={line.number} className="rounded-lg border border-border p-3">
                      <summary className="cursor-pointer text-xs">
                        <span className="mr-2 font-mono text-muted-foreground">{line.number}</span>
                        <span className="mr-2">{line.role}</span>
                        <span className="text-accent">
                          {expressionLabel(expressionFor(line.number))}
                        </span>
                        <span className="ml-2 text-muted-foreground">
                          {draft.expressions[line.number]
                            ? '单句设置'
                            : draft.expressionSource === 'profile'
                              ? '角色默认'
                              : '批次默认'}
                        </span>
                        <span className="mt-1 block truncate text-muted-foreground">
                          {line.text}
                        </span>
                      </summary>
                      <div className="mt-3 border-t border-border pt-3">
                        <ExpressionSettings
                          value={expressionFor(line.number)}
                          text={line.text}
                          label={`${line.number}表达方式`}
                          disabled={creating}
                          onChange={(expression) =>
                            setDraft((previous) => ({
                              ...previous,
                              expressions: { ...previous.expressions, [line.number]: expression },
                            }))
                          }
                        />
                        {draft.expressions[line.number] && (
                          <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="mt-2 h-7 px-0 text-xs"
                            disabled={creating}
                            onClick={() =>
                              setDraft((previous) => {
                                const expressions = { ...previous.expressions };
                                delete expressions[line.number];
                                return { ...previous, expressions };
                              })
                            }
                          >
                            恢复{draft.expressionSource === 'profile' ? '角色' : '批次'}默认表达
                          </Button>
                        )}
                      </div>
                    </details>
                  ))}
                </div>
              </details>
            )}
          </section>
          {creationBlocked && (
            <output className="block text-xs text-muted-foreground">{creationBlocked}</output>
          )}
          {creationError && (
            <p role="alert" className="text-sm text-destructive">
              {creationError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <span className="text-xs text-muted-foreground">
              {parsed.lines.length} 条台词 · {draftRoles.length} 个角色
              <span className="ml-2">关闭弹窗保留草稿</span>
            </span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={creating} onClick={() => setOpen(false)}>
                稍后继续
              </Button>
              <Button
                disabled={creating || !profiles.length || !!parsed.error || !!creationBlocked}
                onClick={() => void createBatch()}
              >
                {creating ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {creating ? '正在加入队列…' : '开始批量生成'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LineCard({
  row,
  profiles,
  base,
  busy,
  expanded,
  onExpand,
  draft,
  onEdit,
  onRedo,
  onSelect,
  onProcess,
}: {
  row: BatchLine;
  profiles: VoiceProfileResponse[];
  base: string;
  busy: boolean;
  expanded: boolean;
  onExpand: () => void;
  draft: LineDraft;
  onEdit: (draft: LineDraft) => void;
  onRedo: () => void;
  onSelect: (generationId: string, versionId: string) => void;
  onProcess: (generationId: string, sourceId: string, speed: number, gain: number) => void;
}) {
  const versions = lineVersions(row);
  const preferred = exportVersion(row);
  const [selected, setSelected] = useState('');
  const [speed, setSpeed] = useState('1');
  const [gain, setGain] = useState('0');
  const choice = versions.find((version) => version.id === selected) || preferred;
  const chosenExpression = normalizeExpression(choice ? choice.expression : row.expression);
  const chosenExpressionLabel = expressionLabel(chosenExpression, choice?.expressionResult);
  const analysisSummary = choice?.expressionResult?.summary?.trim();
  const expressionSummary =
    chosenExpression.mode === 'auto' &&
    analysisSummary &&
    !chosenExpressionLabel.includes(analysisSummary)
      ? analysisSummary
      : '';
  const current = row.takes[row.takes.length - 1];
  const pending = row.takes.some((take) => isPending(take.status));
  const raw = versions.find(
    (version) => version.generationId === choice?.generationId && !version.effects_chain?.length,
  );
  const isSatisfied =
    !!choice && choice.id === preferred?.id && row.preferred_generation_id === choice.generationId;
  const profileName =
    profiles.find((profile) => profile.id === row.profile_id)?.name || '声音档案已移除';
  const audioId = usePlayerStore((s) => s.audioId);
  const playing = usePlayerStore((s) => s.isPlaying);
  const expressionCapabilities = useExpressionCapabilities();
  const expressionBlocked = expressionBlockReason(
    draft.expression,
    expressionCapabilities.isError ? undefined : expressionCapabilities.data,
  );
  const dirty =
    draft.text !== row.text ||
    draft.profileId !== row.profile_id ||
    expressionKey('', draft.expression) !== expressionKey('', normalizeExpression(row.expression));
  // Follow persisted export choice after a mutation without resetting ordinary audition changes on polling.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The changed persisted version is the reset event for audition selection.
  useEffect(() => {
    setSelected('');
  }, [preferred?.id]);
  const play = () => {
    if (!choice) return;
    const player = usePlayerStore.getState();
    if (player.audioId === choice.id) player.setIsPlaying(!player.isPlaying);
    else
      player.setAudioWithAutoPlay(
        `${base}/audio/version/${choice.id}`,
        choice.id,
        row.profile_id,
        `${row.number} · ${row.role} · 第 ${choice.takeNumber} 次`,
      );
  };
  const status = pending
    ? current?.status === 'loading_model'
      ? '等待资源 / 加载模型'
      : '排队 / 生成中'
    : current?.status === 'failed'
      ? '已停止 / 失败'
      : choice
        ? '已完成'
        : '暂无音频';
  return (
    <article
      aria-label={`${row.number} ${row.role}`}
      className={cn(
        'rounded-xl border bg-card transition-colors',
        expanded ? 'border-accent/40' : 'border-border',
      )}
    >
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <span className="font-mono font-semibold text-muted-foreground">{row.number}</span>
          <span className="rounded-md bg-secondary px-2 py-1 font-medium">{row.role}</span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={profileName}>
            {profileName}
          </span>
          <span
            className={cn(
              'flex items-center gap-1.5',
              pending
                ? 'text-accent'
                : current?.status === 'failed'
                  ? 'text-destructive'
                  : 'text-muted-foreground',
            )}
          >
            {pending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : choice ? (
              <Check className="h-3 w-3" />
            ) : null}
            {status}
          </span>
        </div>
        <p className="my-4 whitespace-pre-wrap break-words text-sm leading-7">
          {choice?.text ?? row.text}
        </p>
        <p className="mb-3 text-xs text-muted-foreground" title={expressionSummary || undefined}>
          {choice ? '此版本表达：' : '表达方式：'}
          <span className={cn(chosenExpression.mode !== 'natural' && 'text-accent')}>
            {chosenExpressionLabel}
          </span>
          {expressionSummary && (
            <span>
              {' · '}
              {expressionSummary}
            </span>
          )}
        </p>
        {choice && choice.text !== row.text && (
          <p className="mb-3 text-xs text-muted-foreground">
            正在试听第 {choice.takeNumber} 次的台词。最新文字可在「编辑与后期」中查看。
          </p>
        )}
        {current?.error && (
          <p className="mb-3 break-words text-xs text-destructive">{current.error}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!choice}
            onClick={play}
            aria-label={`${audioId === choice?.id && playing ? '暂停' : '试听'} ${row.number}`}
          >
            {audioId === choice?.id && playing ? <Pause /> : <Play />}
            {audioId === choice?.id && playing ? '暂停' : '试听'}
          </Button>
          {choice ? (
            <>
              <div className="min-w-0 flex-1 sm:max-w-64">
                <Select value={choice.id} onValueChange={setSelected}>
                  <SelectTrigger
                    className="h-9 rounded-full text-xs"
                    aria-label={`${row.number}试听版本`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((version) => (
                      <SelectItem key={version.id} value={version.id}>
                        第 {version.takeNumber} 次 ·{' '}
                        {version.effects_chain?.length ? `后期 · ${version.label}` : '原声'}
                        {' · '}
                        {expressionLabel(version.expression, version.expressionResult)}
                        {version.id === preferred?.id
                          ? row.preferred_generation_id === version.generationId
                            ? ' · 满意版本'
                            : ' · 默认导出'
                          : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || isSatisfied}
                className={cn('text-xs', isSatisfied && 'text-accent disabled:opacity-100')}
                onClick={() => onSelect(choice.generationId, choice.id)}
                aria-label={`${row.number}${isSatisfied ? '已选为满意版本' : '设为满意版本'}`}
              >
                <Star className={cn(isSatisfied && 'fill-current')} />
                <span className="hidden xl:inline">{isSatisfied ? '满意版本' : '设为满意'}</span>
              </Button>
              <Button size="icon" variant="ghost" className="h-9 w-9" asChild>
                <a
                  href={`${base}/audio/version/${choice.id}`}
                  download={`${row.number}.wav`}
                  aria-label={`下载 ${row.number} WAV`}
                  title="下载当前试听版本"
                >
                  <Download />
                </a>
              </Button>
            </>
          ) : (
            <span className="flex-1 text-xs text-muted-foreground">
              完成后可试听、选择版本和下载
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-xs text-muted-foreground"
            onClick={onExpand}
            aria-expanded={expanded}
            aria-label={`编辑 ${row.number}`}
          >
            <SlidersHorizontal />
            编辑与后期
            <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="grid gap-6 border-t border-border bg-background/40 p-4 xl:grid-cols-2">
          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <PencilLine className="h-4 w-4 text-muted-foreground" />
              修改台词{dirty && <span className="ml-auto text-xs text-accent">未生成的修改</span>}
            </h3>
            <Textarea
              aria-label={`${row.number}台词内容`}
              maxLength={2000}
              value={draft.text}
              onChange={(event) => onEdit({ ...draft, text: event.target.value })}
              className="min-h-24 leading-6"
            />
            <VoiceSelect
              label={`${row.number}声音档案`}
              value={draft.profileId}
              profiles={profiles}
              onChange={(profileId) =>
                onEdit({
                  ...draft,
                  profileId,
                  expression: draft.expressionEdited
                    ? draft.expression
                    : normalizeExpression(
                        profiles.find((profile) => profile.id === profileId)?.default_expression,
                      ),
                })
              }
            />
            <div className="rounded-lg border border-border bg-card p-3">
              <ExpressionSettings
                label={`${row.number}表达方式`}
                value={draft.expression}
                text={draft.text}
                disabled={busy || pending}
                onChange={(expression) => onEdit({ ...draft, expression, expressionEdited: true })}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">重做会保留此前的每个版本</span>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  busy ||
                  pending ||
                  !!expressionBlocked ||
                  !draft.text.trim() ||
                  !profiles.some((p) => p.id === draft.profileId)
                }
                onClick={onRedo}
              >
                <RotateCcw />
                修改并重做
              </Button>
            </div>
          </div>
          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              声音后期
            </h3>
            <p className="text-xs leading-5 text-muted-foreground">
              {choice
                ? `使用第 ${choice.takeNumber} 次生成的原声，调整语速与音量。无需重新生成。`
                : '生成完成后即可调整语速与音量。'}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor={`${row.number}-speed`} className="text-xs">
                  语速 / 倍
                </Label>
                <Input
                  id={`${row.number}-speed`}
                  type="number"
                  min="0.5"
                  max="2"
                  step="0.05"
                  value={speed}
                  onChange={(event) => setSpeed(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${row.number}-gain`} className="text-xs">
                  音量 / dB
                </Label>
                <Input
                  id={`${row.number}-gain`}
                  type="number"
                  min="-40"
                  max="40"
                  step="1"
                  value={gain}
                  onChange={(event) => setGain(event.target.value)}
                />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !raw || !speed || !gain}
              onClick={() =>
                raw && onProcess(raw.generationId, raw.id, Number(speed), Number(gain))
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}保存后期版本
            </Button>
            <p className="text-xs text-muted-foreground">
              保存后自动设为满意版本，原声仍可随时选回。
            </p>
            {choice && choice.text !== row.text && (
              <div className="rounded-lg bg-muted/50 p-3 text-xs leading-5">
                <span className="mb-1 flex items-center gap-1.5 text-muted-foreground">
                  <FileAudio className="h-3 w-3" />
                  当前试听版本的台词
                </span>
                {choice.text}
              </div>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

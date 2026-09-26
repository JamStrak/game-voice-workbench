import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRight,
  AudioLines,
  Check,
  ChevronRight,
  Headphones,
  Loader2,
  Pause,
  Play,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ExpressionSettings } from '@/components/Generation/ExpressionSettings';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import type { LibrarySample, LibraryVoice, VoiceProfileResponse } from '@/lib/api/types';
import { NATURAL_EXPRESSION, type Expression } from '@/lib/expression';
import { cn } from '@/lib/utils/cn';
import { filterLibraryVoices, roleEffects, upsertProfileList } from '@/lib/voice-library';
import { isAudioPlaying, usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';

function languageName(language: string) {
  return (
    (
      {
        zh: '中文',
        en: '英语',
        ja: '日语',
        ko: '韩语',
        Chinese: '中文',
        English: '英语',
        Japanese: '日语',
        Korean: '韩语',
      } as Record<string, string>
    )[language] || language
  );
}

export function VoiceLibrary({ onVariantSaved }: { onVariantSaved: () => void }) {
  const base = useServerStore((state) => state.serverUrl);
  const hasPlayer = usePlayerStore((state) => !!state.audioUrl);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [gender, setGender] = useState('all');
  const [tag, setTag] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [variantOpen, setVariantOpen] = useState(false);
  const [error, setError] = useState('');
  const library = useQuery({
    queryKey: ['voice-library', base],
    queryFn: () => apiClient.getVoiceLibrary(),
    refetchInterval: (query) =>
      query.state.data?.voices.some((voice) =>
        voice.samples.some((sample) => sample.status === 'pending'),
      )
        ? 10000
        : false,
  });
  const voices = library.data?.voices || [];
  const filtered = useMemo(
    () => filterLibraryVoices(voices, search, gender === 'all' ? '' : gender, tag),
    [voices, search, gender, tag],
  );
  const selected = filtered.find((voice) => voice.id === selectedId) || filtered[0];
  const tags = [...new Set(voices.flatMap((voice) => voice.tags))];
  const readyCount = voices.reduce(
    (count, voice) => count + voice.samples.filter((sample) => sample.status === 'ready').length,
    0,
  );
  const useVoice = useMutation({
    mutationFn: (id: string) => apiClient.useLibraryVoice(id),
    onSuccess: async (profile) => {
      queryClient.setQueryData(['profiles', profile.id], profile);
      queryClient.setQueryData<VoiceProfileResponse[]>(['profiles'], (previous) =>
        upsertProfileList(previous, profile),
      );
      await queryClient.invalidateQueries({ queryKey: ['profiles'] });
      useUIStore.getState().setSelectedProfileId(profile.id);
      useUIStore.getState().setSelectedEngine('qwen_custom_voice');
      toast({
        title: `已选用「${profile.name}」`,
        description: '在下方输入台词，可以继续调整表达方式。',
      });
      void navigate({ to: '/' });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : '选用未完成，请重试。'),
  });
  if (library.isLoading)
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在打开声音库…
      </div>
    );
  if (library.isError)
    return (
      <div role="alert" className="rounded-xl border border-border bg-card p-6">
        <p className="mb-3 text-sm">声音库暂时无法加载：{library.error.message}</p>
        <Button variant="outline" onClick={() => void library.refetch()}>
          重新加载
        </Button>
      </div>
    );
  return (
    <div
      className="h-full overflow-y-auto pb-8 pr-1"
      style={hasPlayer ? { height: 'calc(100% - 8rem)' } : undefined}
    >
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索声音库"
            placeholder="搜索角色、音色或适用场景"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={gender} onValueChange={setGender}>
          <SelectTrigger className="w-28" aria-label="声音性别">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部声音</SelectItem>
            <SelectItem value="female">女声</SelectItem>
            <SelectItem value="male">男声</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {voices.length} 种音色 · {readyCount} 段试听
        </span>
      </div>
      <div className="mb-6 flex flex-wrap gap-2" aria-label="按风格筛选">
        {['', ...tags].map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => setTag(item)}
            aria-pressed={tag === item}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tag === item
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border text-muted-foreground hover:border-accent/30 hover:text-foreground',
            )}
          >
            {item || '全部风格'}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-label="内置角色音色" className="min-w-0">
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {filtered.map((voice, index) => (
              <button
                type="button"
                key={voice.id}
                onClick={() => {
                  setSelectedId(voice.id);
                  setError('');
                }}
                aria-pressed={selected?.id === voice.id}
                className={cn(
                  'group flex min-h-52 flex-col rounded-xl border bg-card p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected?.id === voice.id
                    ? 'border-accent/60 bg-accent/5'
                    : 'border-border hover:border-accent/30',
                )}
              >
                <div className="mb-4 flex w-full items-center justify-between">
                  <div
                    className={cn(
                      'flex h-11 w-11 items-center justify-center rounded-full border font-mono text-sm',
                      selected?.id === voice.id
                        ? 'border-accent/20 bg-accent/10 text-accent'
                        : 'border-border bg-secondary text-muted-foreground',
                    )}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </div>
                  {selected?.id === voice.id ? (
                    <Check className="h-4 w-4 text-accent" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  )}
                </div>
                <h2 className="text-base font-semibold">{voice.name}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {voice.gender === 'female' ? '女声' : '男声'} ·{' '}
                  {languageName(voice.native_language)}原生音色
                </p>
                <p className="mt-3 flex-1 text-xs leading-5 text-muted-foreground">
                  {voice.description}
                </p>
                <div className="mt-4 flex w-full items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <span className="truncate text-xs text-muted-foreground">
                    {voice.tags.slice(0, 2).join(' / ')}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
                    <Headphones className="h-3 w-3" />
                    {voice.samples.filter((sample) => sample.status === 'ready').length} 段试听
                  </span>
                </div>
              </button>
            ))}
          </div>
          {!filtered.length && (
            <div className="rounded-xl border border-dashed border-border py-16 text-center">
              <p className="mb-3 text-sm text-muted-foreground">没有找到符合条件的声音。</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setGender('all');
                  setTag('');
                }}
              >
                清除筛选
              </Button>
            </div>
          )}
          <p className="mt-5 text-xs leading-5 text-muted-foreground">
            试听为模型生成的短句。角色标签用于选角参考，最终听感请以试听为准。
            自然试听来自 Qwen，情绪试听适用 IndexTTS 的独立条款。
            <a
              href="https://github.com/JamStrak/game-voice-workbench/blob/main/THIRD_PARTY_NOTICES.md"
              target="_blank"
              rel="noreferrer"
              className="ml-1 text-accent underline underline-offset-2"
            >
              查看声音与模型许可
            </a>
          </p>
        </section>
        {selected && (
          <aside
            className="overflow-y-auto rounded-xl border border-border bg-card p-5 lg:sticky lg:top-0"
            style={{ maxHeight: hasPlayer ? 'calc(100dvh - 320px)' : 'calc(100dvh - 192px)' }}
            aria-label={`${selected.name}试听详情`}
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                <AudioLines className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">当前选中的音色</p>
                <h2 className="mt-1 text-xl font-semibold">{selected.name}</h2>
              </div>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">{selected.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selected.tags.map((item) => (
                <span
                  key={item}
                  className="rounded bg-secondary px-2 py-1 text-xs text-muted-foreground"
                >
                  {item}
                </span>
              ))}
            </div>
            <div className="mb-3 mt-6 flex items-center justify-between">
              <h3 className="text-sm font-medium">听听不同的表达</h3>
              <span className="text-xs text-muted-foreground">短句试听</span>
            </div>
            <div className="space-y-2">
              {selected.samples.map((sample) => (
                <PreviewRow key={`${selected.id}-${sample.id}`} voice={selected} sample={sample} />
              ))}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              自然试听保留原声音色；情绪试听重新演绎台词，音色可能略有变化。
            </p>
            <div className="mt-5 space-y-2 border-t border-border pt-5">
              <Button
                className="w-full"
                disabled={useVoice.isPending}
                onClick={() => {
                  setError('');
                  useVoice.mutate(selected.id);
                }}
              >
                {useVoice.isPending ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                使用此音色
              </Button>
              <Button className="w-full" variant="outline" onClick={() => setVariantOpen(true)}>
                <SlidersHorizontal />
                保存为项目角色
              </Button>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              项目角色可单独保存默认情绪、语速与音高，以后在配音和角色台词中直接选择。
            </p>
            <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground">
              原声音色 · {selected.speaker}
            </p>
          </aside>
        )}
      </div>
      {selected && (
        <RoleVariantDialog
          key={selected.id}
          voice={selected}
          open={variantOpen}
          onOpenChange={setVariantOpen}
          onSaved={(profile) => {
            useUIStore.getState().setSelectedVoiceId(profile.id);
            onVariantSaved();
          }}
        />
      )}
    </div>
  );
}

export function PreviewRow({
  voice,
  sample,
}: {
  voice: Pick<LibraryVoice, 'id' | 'name'>;
  sample: LibrarySample;
}) {
  const base = useServerStore((state) => state.serverUrl);
  const id = `library:${voice.id}:${sample.id}:${sample.audio_url || ''}`;
  const active = usePlayerStore((state) => isAudioPlaying(state, id));
  const ready = sample.status === 'ready' && !!sample.audio_url;
  function play() {
    if (!ready) return;
    const player = usePlayerStore.getState();
    if (player.audioId === id) player.setIsPlaying(!player.isPlaying);
    else {
      player.setOnFinish(null);
      player.setAudioWithAutoPlay(
        new URL(sample.audio_url!, `${base}/`).href,
        id,
        null,
        `${voice.name} · ${sample.label}`,
      );
    }
  }
  return (
    <button
      type="button"
      onClick={play}
      disabled={!ready}
      aria-label={`${active ? '暂停' : '试听'} ${voice.name} ${sample.label}`}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60',
        active ? 'border-accent/40 bg-accent/5' : 'border-border hover:bg-secondary/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          ready ? 'bg-accent/10 text-accent' : 'bg-secondary text-muted-foreground',
        )}
      >
        {active ? (
          <Pause className="h-3.5 w-3.5" />
        ) : ready ? (
          <Play className="ml-0.5 h-3.5 w-3.5" />
        ) : (
          <AudioLines className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2 text-xs font-medium">
          <span>{sample.label}</span>
          <span className="font-normal text-muted-foreground">
            {ready
              ? `${(sample.duration || 0).toFixed(1)} 秒`
              : sample.status === 'failed'
                ? '暂不可试听'
                : '准备中'}
          </span>
        </span>
        <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{sample.text}</span>
        {sample.status === 'failed' && sample.error && (
          <span className="mt-1 block text-xs text-destructive">{sample.error}</span>
        )}
      </span>
    </button>
  );
}

function RoleVariantDialog({
  voice,
  open,
  onOpenChange,
  onSaved,
}: {
  voice: LibraryVoice;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (profile: VoiceProfileResponse) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(`${voice.name} · 角色版`);
  const [project, setProject] = useState('');
  const [expression, setExpression] = useState<Expression>({ ...NATURAL_EXPRESSION });
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);
  const mutation = useMutation({
    mutationFn: () =>
      apiClient.createLibraryVariant(voice.id, {
        name: name.trim(),
        project_name: project.trim() || undefined,
        expression,
        effects_chain: roleEffects(speed, pitch),
      }),
    onSuccess: async (profile) => {
      queryClient.setQueryData(['profiles', profile.id], profile);
      queryClient.setQueryData<VoiceProfileResponse[]>(['profiles'], (previous) =>
        upsertProfileList(previous, profile),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['voice-library'] }),
      ]);
      toast({
        title: `已保存「${profile.name}」`,
        description: '在「我的声音」中管理，也可以在配音和角色台词中选用。',
      });
      onOpenChange(false);
      onSaved(profile);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!mutation.isPending) onOpenChange(value);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>保存为项目角色</DialogTitle>
          <DialogDescription>
            以「{voice.name}」为基础，保存这个角色自己的声音设置。
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!mutation.isPending && name.trim()) mutation.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="role-name">角色名称</Label>
              <Input
                id="role-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
                disabled={mutation.isPending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-project">
                项目名称 <span className="text-muted-foreground">· 可选</span>
              </Label>
              <Input
                id="role-project"
                value={project}
                onChange={(event) => setProject(event.target.value)}
                placeholder="例如：城门故事"
                maxLength={100}
                disabled={mutation.isPending}
              />
            </div>
          </div>
          <div className="rounded-lg border border-border p-4">
            <ExpressionSettings
              label="角色默认表达"
              value={expression}
              text=""
              showPreview={false}
              onChange={setExpression}
              disabled={mutation.isPending}
            />
          </div>
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div>
              <Label htmlFor="role-speed" className="mb-3 flex items-center justify-between">
                语速 <span className="font-mono text-accent">{speed.toFixed(2)} ×</span>
              </Label>
              <Slider
                id="role-speed"
                aria-label="角色语速"
                min={0.75}
                max={1.5}
                step={0.05}
                value={[speed]}
                onValueChange={([value]) => setSpeed(value)}
                disabled={mutation.isPending}
              />
            </div>
            <div>
              <Label htmlFor="role-pitch" className="mb-3 flex items-center justify-between">
                音高{' '}
                <span className="font-mono text-accent">
                  {pitch > 0 ? '+' : ''}
                  {pitch} 半音
                </span>
              </Label>
              <Slider
                id="role-pitch"
                aria-label="角色音高"
                min={-4}
                max={4}
                step={0.5}
                value={[pitch]}
                onValueChange={([value]) => setPitch(value)}
                disabled={mutation.isPending}
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              语速和音高会应用到之后生成的成品。音高微调可改变声音高低，建议先小幅调整再试听。
            </p>
          </div>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending || !name.trim()}>
              {mutation.isPending ? <Loader2 className="animate-spin" /> : <Check />}
              {mutation.isPending ? '正在保存…' : '保存角色'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

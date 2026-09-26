import { Mic, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProfileForm } from '@/components/VoiceProfiles/ProfileForm';
import { expressionLabel } from '@/lib/expression';
import { useProfiles } from '@/lib/hooks/useProfiles';
import { cn } from '@/lib/utils/cn';
import { useUIStore } from '@/stores/uiStore';
import { VoiceInspector } from './VoiceInspector';

export function PersonalVoices() {
  const { data: allProfiles, isLoading, isFetching, error } = useProfiles();
  const profiles = useMemo(
    () => allProfiles?.filter((profile) => !profile.is_builtin) || [],
    [allProfiles],
  );
  const setDialogOpen = useUIStore((state) => state.setProfileDialogOpen);
  const selectedVoiceId = useUIStore((state) => state.selectedVoiceId);
  const setSelectedVoiceId = useUIStore((state) => state.setSelectedVoiceId);
  const [search, setSearch] = useState('');
  const filtered = profiles.filter((profile) =>
    [profile.name, profile.description, profile.project_name, profile.language]
      .join(' ')
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  useEffect(() => {
    // A stale or not-yet-loaded list is not evidence that the selected role was deleted.
    if (!allProfiles || isFetching) return;
    if (!profiles.some((profile) => profile.id === selectedVoiceId))
      setSelectedVoiceId(profiles[0]?.id || null);
  }, [allProfiles, isFetching, profiles, selectedVoiceId, setSelectedVoiceId]);
  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">正在加载声音档案…</p>;
  if (error)
    return (
      <p role="alert" className="p-8 text-sm text-destructive">
        无法加载声音档案：{error.message}
      </p>
    );
  return (
    <div className="grid h-full min-h-0 gap-5 overflow-y-auto pb-36 lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden lg:pb-0">
      <section className="min-w-0 lg:overflow-y-auto lg:pb-36" aria-label="我的声音档案">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative min-w-40 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索我的声音"
              placeholder="搜索角色、项目或描述"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            onClick={() => {
              useUIStore.getState().setEditingProfileId(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            新建声音
          </Button>
        </div>
        <p className="mb-4 text-xs leading-5 text-muted-foreground">
          你的克隆声音、已保存的项目角色与个人预置都在这里。角色设置会在下次选用时自动带入。
        </p>
        <div className="space-y-2">
          {filtered.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => setSelectedVoiceId(profile.id)}
              aria-pressed={selectedVoiceId === profile.id}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selectedVoiceId === profile.id
                  ? 'border-accent/50 bg-accent/5'
                  : 'border-border bg-card hover:border-accent/30',
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <Mic className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-medium">{profile.name}</h2>
                  <span className="text-xs text-accent">
                    {expressionLabel(profile.default_expression)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {profile.description || '为这个声音补充角色描述，方便下次选择。'}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {profile.project_name ||
                      (profile.library_voice_id
                        ? '项目角色'
                        : profile.voice_type === 'preset'
                          ? '个人预置'
                          : '克隆声音')}
                  </span>
                  <span>
                    {profile.voice_type === 'preset'
                      ? '无需参考录音'
                      : `${profile.sample_count} 段参考录音`}
                  </span>
                  <span>{profile.generation_count} 次生成</span>
                </div>
              </div>
            </button>
          ))}
        </div>
        {!filtered.length && (
          <div className="rounded-xl border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
            {search ? '没有找到符合条件的声音。' : '从内置声音库保存一个角色，或新建自己的声音。'}
          </div>
        )}
      </section>
      {selectedVoiceId && (
        <aside className="min-h-0 overflow-hidden rounded-xl border border-border bg-card">
          <VoiceInspector key={selectedVoiceId} profileId={selectedVoiceId} />
        </aside>
      )}
      <ProfileForm />
    </div>
  );
}

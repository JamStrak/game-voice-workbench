import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight, Edit2, Mic, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import * as z from 'zod';
import { EffectsChainEditor } from '@/components/Effects/EffectsChainEditor';
import { ExpressionSettings } from '@/components/Generation/ExpressionSettings';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { SampleList } from '@/components/VoiceProfiles/SampleList';
import { apiClient } from '@/lib/api/client';
import type { EffectConfig } from '@/lib/api/types';
import { LANGUAGE_CODES, LANGUAGE_OPTIONS, type LanguageCode } from '@/lib/constants/languages';
import { BOTTOM_SAFE_AREA_PADDING } from '@/lib/constants/ui';
import { NATURAL_EXPRESSION, normalizeExpression, type Expression } from '@/lib/expression';
import { useDeleteAvatar, useProfile, useUploadAvatar } from '@/lib/hooks/useProfiles';
import { cn } from '@/lib/utils/cn';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';
import { useUIStore } from '@/stores/uiStore';
import { PreviewRow } from './VoiceLibrary';

function makeProfileSchema(t: (key: string) => string) {
  return z.object({
    name: z.string().min(1, t('profileForm.validation.nameRequired')).max(100),
    description: z.string().max(500).optional(),
    project_name: z.string().max(100).optional(),
    language: z.enum(LANGUAGE_CODES as [LanguageCode, ...LanguageCode[]]),
  });
}

type ProfileFormValues = {
  name: string;
  description?: string;
  project_name?: string;
  language: LanguageCode;
};

interface VoiceInspectorProps {
  profileId: string;
}

export function VoiceInspector({ profileId }: VoiceInspectorProps) {
  const { t } = useTranslation();
  const { data: profile } = useProfile(profileId);
  const audioUrl = usePlayerStore((state) => state.audioUrl);
  const isPlayerVisible = !!audioUrl;
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const initializedProfile = useRef<string | null>(null);
  const uploadAvatar = useUploadAvatar();
  const deleteAvatar = useDeleteAvatar();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const { toast } = useToast();
  const navigate = useNavigate();
  const library = useQuery({
    queryKey: ['voice-library', serverUrl],
    queryFn: () => apiClient.getVoiceLibrary(),
  });
  const previews =
    library.data?.personal_voices.find((voice) => voice.id === profileId)?.samples || [];
  const sourcePreviews =
    library.data?.voices.find((voice) => voice.id === profile?.library_voice_id)?.samples || [];
  const [expression, setExpression] = useState<Expression>({ ...NATURAL_EXPRESSION });
  const [expressionDirty, setExpressionDirty] = useState(false);

  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const [effectsChain, setEffectsChain] = useState<EffectConfig[]>([]);
  const [effectsDirty, setEffectsDirty] = useState(false);

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(makeProfileSchema(t)),
    defaultValues: {
      name: '',
      description: '',
      project_name: '',
      language: 'en',
    },
  });

  // Populate form when profile loads
  useEffect(() => {
    if (profile && initializedProfile.current !== profile.id) {
      initializedProfile.current = profile.id;
      form.reset({
        name: profile.name,
        description: profile.description || '',
        project_name: profile.project_name || '',
        language: profile.language as LanguageCode,
      });
      setEffectsChain(profile.effects_chain ?? []);
      setEffectsDirty(false);
      setExpression(normalizeExpression(profile.default_expression));
      setExpressionDirty(false);
    }
  }, [profile, form]);

  // Avatar preview
  useEffect(() => {
    if (profile?.avatar_path) {
      setAvatarPreview(`${serverUrl}/profiles/${profile.id}/avatar`);
    } else {
      setAvatarPreview(null);
    }
    setAvatarError(false);
  }, [profile, serverUrl]);

  function handleAvatarFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast({
        title: t('profileForm.toast.invalidFile'),
        description: t('voiceInspector.toast.invalidImageFormat'),
        variant: 'destructive',
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('profileForm.toast.fileTooLarge'),
        description: t('profileForm.toast.imageTooLargeDescription'),
        variant: 'destructive',
      });
      return;
    }
    uploadAvatar.mutate(
      { profileId, file },
      {
        onSuccess: () => {
          setAvatarPreview(URL.createObjectURL(file));
          toast({ title: t('voiceInspector.toast.avatarUpdated') });
        },
        onError: (err) => {
          toast({
            title: t('profileForm.toast.avatarUploadFailed'),
            description: err instanceof Error ? err.message : t('common.unknownError'),
            variant: 'destructive',
          });
        },
      },
    );
  }

  async function handleRemoveAvatar() {
    if (profile?.avatar_path) {
      try {
        await deleteAvatar.mutateAsync(profileId);
        toast({ title: t('profileForm.toast.avatarRemoved') });
      } catch (err) {
        toast({
          title: t('profileForm.toast.avatarRemoveFailed'),
          description: err instanceof Error ? err.message : t('common.unknownError'),
          variant: 'destructive',
        });
      }
    }
    setAvatarPreview(null);
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  }

  async function onSubmit(data: ProfileFormValues) {
    if (saving) return;
    setSaving(true);
    try {
      let saved = await apiClient.updateProfile(profileId, {
        name: data.name,
        description: data.description,
        language: data.language,
        project_name: data.project_name || '',
        default_expression: expression,
      });

      if (effectsDirty) {
        saved = await apiClient.updateProfileEffects(
          profileId,
          effectsChain.length > 0 ? effectsChain : null,
        );
      }

      queryClient.setQueryData(['profiles', profileId], saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['voice-library'] }),
      ]);
      form.reset({
        name: saved.name,
        description: saved.description || '',
        language: saved.language as LanguageCode,
        project_name: saved.project_name || '',
      });
      setEffectsChain(saved.effects_chain || []);
      setEffectsDirty(false);
      setExpression(normalizeExpression(saved.default_expression));
      setExpressionDirty(false);

      toast({
        title: t('profileForm.toast.voiceUpdated'),
        description: t('voiceInspector.toast.savedDescription', { name: data.name }),
      });
    } catch (error) {
      toast({
        title: t('common.error'),
        description: error instanceof Error ? error.message : t('profileForm.toast.saveFailed'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  if (!profile) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('voiceInspector.loading')}
      </div>
    );
  }

  if (profile.is_builtin)
    return (
      <div className="space-y-3 p-5">
        <h2 className="font-medium">{profile.name}</h2>
        <p className="text-sm text-muted-foreground">
          内置音色保存在声音库中，可从那里创建独立的项目角色。
        </p>
        <Button asChild variant="outline">
          <Link to="/voices">打开声音库</Link>
        </Button>
      </div>
    );

  const isDirty = form.formState.isDirty || effectsDirty || expressionDirty;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className={cn('flex-1 overflow-y-auto', isPlayerVisible && BOTTOM_SAFE_AREA_PADDING)}>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-0">
            <fieldset disabled={saving} className="min-w-0 border-0 p-0">
              {/* Avatar */}
              <div className="flex justify-center pt-5 pb-3">
                <div className="relative group">
                  <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden border-2 border-border">
                    {avatarPreview && !avatarError ? (
                      <img
                        src={avatarPreview}
                        alt={profile.name}
                        className="h-full w-full object-cover"
                        onError={() => setAvatarError(true)}
                      />
                    ) : (
                      <Mic className="h-8 w-8 text-muted-foreground" />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    className="absolute inset-0 rounded-full bg-accent/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
                  >
                    <Edit2 className="h-5 w-5 text-accent-foreground" />
                  </button>
                  {avatarPreview && (
                    <button
                      type="button"
                      onClick={handleRemoveAvatar}
                      disabled={deleteAvatar.isPending}
                      className="absolute bottom-0 right-0 h-5 w-5 rounded-full bg-background/60 backdrop-blur-sm text-muted-foreground flex items-center justify-center hover:bg-background/80 hover:text-foreground transition-colors shadow-sm border border-border/50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleAvatarFileChange}
                  className="hidden"
                />
              </div>

              {/* Fields */}
              <div className="space-y-3 px-5">
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => {
                    useUIStore.getState().setSelectedProfileId(profile.id);
                    void navigate({ to: '/' });
                  }}
                >
                  <ArrowRight />
                  使用这个声音
                </Button>
                {previews.length > 0 && (
                  <section className="space-y-2 py-3" aria-label="成品试听">
                    <h3 className="text-sm font-medium">成品试听</h3>
                    {previews.map((sample) => (
                      <PreviewRow key={sample.id} voice={profile} sample={sample} />
                    ))}
                  </section>
                )}
                {!previews.length && sourcePreviews.length > 0 && (
                  <section className="space-y-2 py-3" aria-label="原始音色试听">
                    <h3 className="text-sm font-medium">原始音色试听</h3>
                    <p className="text-xs leading-5 text-muted-foreground">
                      以下示例尚未应用这个角色的语速、音高设置；生成后的成品会显示在这里。
                    </p>
                    {sourcePreviews.map((sample) => (
                      <PreviewRow key={sample.id} voice={profile} sample={sample} />
                    ))}
                  </section>
                )}
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('profileForm.fields.name')}</FormLabel>
                      <FormControl>
                        <Input placeholder={t('profileForm.fields.namePlaceholder')} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('voiceInspector.fields.description')}</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder={t('profileForm.fields.descriptionPlaceholder')}
                          rows={2}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="project_name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>所属项目</FormLabel>
                      <FormControl>
                        <Input placeholder="项目名称，可选" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="language"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('profileForm.fields.language')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {LANGUAGE_OPTIONS.map((lang) => (
                            <SelectItem key={lang.value} value={lang.value}>
                              {lang.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Effects */}
                <div className="rounded-lg border border-border p-3">
                  <ExpressionSettings
                    label="角色默认表达"
                    value={expression}
                    text=""
                    showPreview={false}
                    onChange={(value) => {
                      setExpression(value);
                      setExpressionDirty(true);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <FormLabel>{t('profileForm.fields.defaultEffects')}</FormLabel>
                  <p className="text-xs text-muted-foreground">
                    {t('voiceInspector.defaultEffectsHint')}
                  </p>
                  <EffectsChainEditor
                    value={effectsChain}
                    onChange={(chain) => {
                      setEffectsChain(chain);
                      setEffectsDirty(true);
                    }}
                    compact
                  />
                </div>

                {/* Save */}
                {isDirty && (
                  <Button type="submit" className="w-full" disabled={saving}>
                    {saving
                      ? t('profileForm.actions.saving')
                      : t('profileForm.actions.saveChanges')}
                  </Button>
                )}
              </div>

              {/* Samples */}
              <div className="px-5 pb-5">
                {profile.voice_type === 'preset' ? (
                  <p className="mt-5 rounded-lg border border-border bg-secondary/50 p-3 text-xs leading-5 text-muted-foreground">
                    这是预置音色，可以直接选用，无需添加克隆参考录音。试听请使用上方成品，或从声音库听取原音色示例。
                  </p>
                ) : (
                  <>
                    <h3 className="mt-5 text-sm font-medium">克隆参考录音</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      参考录音用于保持音色，与生成后的成品试听不同。
                    </p>
                    <SampleList profileId={profileId} />
                  </>
                )}
              </div>
            </fieldset>
          </form>
        </Form>
      </div>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useMatchRoute } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { getLanguageOptionsForEngine, type LanguageCode } from '@/lib/constants/languages';
import { expressionBlockReason, expressionLabel, normalizeExpression } from '@/lib/expression';
import { useExpressionCapabilities } from '@/lib/hooks/useExpression';
import { useGenerationForm } from '@/lib/hooks/useGenerationForm';
import { useProfile, useProfiles } from '@/lib/hooks/useProfiles';
import { useStory } from '@/lib/hooks/useStories';
import { cn } from '@/lib/utils/cn';
import { useGenerationStore } from '@/stores/generationStore';
import { useStoryStore } from '@/stores/storyStore';
import { useUIStore } from '@/stores/uiStore';
import { EngineModelSelector } from './EngineModelSelector';
import { ExpressionSettings } from './ExpressionSettings';
import { ParalinguisticInput } from './ParalinguisticInput';

interface FloatingGenerateBoxProps {
  isPlayerOpen?: boolean;
  showVoiceSelector?: boolean;
}

export function FloatingGenerateBox({
  isPlayerOpen = false,
  showVoiceSelector = false,
}: FloatingGenerateBoxProps) {
  const { t } = useTranslation();
  const selectedProfileId = useUIStore((state) => state.selectedProfileId);
  const setSelectedProfileId = useUIStore((state) => state.setSelectedProfileId);
  const setSelectedEngine = useUIStore((state) => state.setSelectedEngine);
  const setEmotionEnabled = useUIStore((state) => state.setEmotionEnabled);
  const { data: selectedProfile } = useProfile(selectedProfileId || '');
  const { data: profiles } = useProfiles();
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const matchRoute = useMatchRoute();
  const isStoriesRoute = matchRoute({ to: '/stories' });
  const selectedStoryId = useStoryStore((state) => state.selectedStoryId);
  const trackEditorHeight = useStoryStore((state) => state.trackEditorHeight);
  const { data: currentStory } = useStory(selectedStoryId);
  const addPendingStoryAdd = useGenerationStore((s) => s.addPendingStoryAdd);
  // Fetch effect presets for the dropdown
  const { data: effectPresets } = useQuery({
    queryKey: ['effectPresets'],
    queryFn: () => apiClient.listEffectPresets(),
  });

  // Calculate if track editor is visible (on stories route with items)
  const hasTrackEditor = isStoriesRoute && currentStory && currentStory.items.length > 0;

  const { form, handleSubmit, isPending } = useGenerationForm({
    onSuccess: async (generationId) => {
      setIsExpanded(false);
      // Defer the story add until TTS completes -- useGenerationProgress handles it
      if (isStoriesRoute && selectedStoryId && generationId) {
        addPendingStoryAdd(generationId, selectedStoryId);
      }
    },
    getEffectsChain: () => {
      if (!selectedPresetId) return [];
      // Profile's own effects chain (no matching preset)
      if (selectedPresetId === '_profile') {
        return selectedProfile?.effects_chain ?? undefined;
      }
      if (!effectPresets) return undefined;
      const preset = effectPresets.find((p) => p.id === selectedPresetId);
      return preset?.effects_chain;
    },
  });
  const expression = normalizeExpression(form.watch('expression'));
  const expressionCapabilities = useExpressionCapabilities();
  const expressionProfileRef = useRef<string | null>(null);
  const expressionEditedRef = useRef(false);
  useEffect(() => {
    expressionProfileRef.current = null;
    expressionEditedRef.current = false;
  }, [selectedProfileId]);
  // Apply a saved role once when selected. Refetches must not overwrite a user's sentence edit.
  useEffect(() => {
    if (!selectedProfileId) expressionProfileRef.current = null;
    if (
      selectedProfile?.id === selectedProfileId &&
      expressionProfileRef.current !== selectedProfile.id
    ) {
      expressionProfileRef.current = selectedProfile.id;
      if (!expressionEditedRef.current) {
        form.setValue('expression', normalizeExpression(selectedProfile.default_expression));
      }
    }
  }, [selectedProfile, selectedProfileId, form]);
  const expressionBlocked = expressionBlockReason(
    expression,
    expressionCapabilities.isError ? undefined : expressionCapabilities.data,
  );
  useEffect(() => {
    setEmotionEnabled(expression.mode !== 'natural');
    return () => setEmotionEnabled(false);
  }, [expression.mode, setEmotionEnabled]);

  // Click away handler to collapse the box
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;

      // Don't collapse if clicking inside the container
      if (containerRef.current?.contains(target)) {
        return;
      }

      // Don't collapse if clicking on a Select dropdown (which renders in a portal)
      if (
        target.closest('[role="listbox"]') ||
        target.closest('[data-radix-popper-content-wrapper]')
      ) {
        return;
      }

      setIsExpanded(false);
    }

    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isExpanded]);

  // Set first voice as default if none selected
  useEffect(() => {
    if (!selectedProfileId && profiles && profiles.length > 0) {
      setSelectedProfileId(
        (
          profiles.find((p) => p.preset_voice_id === 'Ryan' && !p.effects_chain?.length) ||
          profiles.find((p) => !p.effects_chain?.length) ||
          profiles[0]
        ).id,
      );
    }
  }, [selectedProfileId, profiles, setSelectedProfileId]);

  // Sync engine selection to global store so ProfileList can filter
  const watchedEngine = form.watch('engine');
  useEffect(() => {
    if (watchedEngine) {
      setSelectedEngine(watchedEngine);
    }
  }, [watchedEngine, setSelectedEngine]);

  // Sync generation form language, engine, and effects with selected profile
  type EngineValue =
    | 'qwen'
    | 'luxtts'
    | 'chatterbox'
    | 'chatterbox_turbo'
    | 'tada'
    | 'kokoro'
    | 'qwen_custom_voice';
  useEffect(() => {
    if (selectedProfile?.language) {
      form.setValue('language', selectedProfile.language as LanguageCode);
    }
    // Auto-switch engine to match the profile
    const engine = selectedProfile?.default_engine ?? selectedProfile?.preset_engine;
    if (engine) {
      form.setValue('engine', engine as EngineValue);
    } else if (selectedProfile && selectedProfile.voice_type !== 'preset') {
      // Cloned/designed profile with no default — ensure a compatible (non-preset) engine
      const currentEngine = form.getValues('engine');
      const presetEngines = new Set(['kokoro', 'qwen_custom_voice']);
      if (currentEngine && presetEngines.has(currentEngine)) {
        form.setValue('engine', 'qwen');
      }
    }
    // Pre-fill effects from profile defaults
    if (selectedProfile?.effects_chain && selectedProfile.effects_chain.length > 0) {
      // Try to match against a known preset
      const profileChainJson = JSON.stringify(selectedProfile.effects_chain);
      const matchingPreset = effectPresets?.find(
        (p) => JSON.stringify(p.effects_chain) === profileChainJson,
      );
      if (matchingPreset) {
        setSelectedPresetId(matchingPreset.id);
      } else {
        // No matching preset — use special value to pass profile chain directly
        setSelectedPresetId('_profile');
      }
    } else if (
      selectedProfile &&
      (!selectedProfile.effects_chain || selectedProfile.effects_chain.length === 0)
    ) {
      setSelectedPresetId(null);
    }
    // Persona toggle only applies when the profile has a personality prompt.
    if (selectedProfile && !selectedProfile.personality?.trim()) {
      form.setValue('personality', false);
    }
  }, [selectedProfile, effectPresets, form]);

  // Auto-resize textarea based on content (only when expanded)
  useEffect(() => {
    if (!isExpanded) {
      // Reset textarea height after collapse animation completes
      const timeoutId = setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = '32px';
          textarea.style.overflowY = 'hidden';
        }
      }, 200); // Wait for animation to complete
      return () => clearTimeout(timeoutId);
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const minHeight = 100; // Expanded minimum
      const maxHeight = 300; // Max height in pixels
      const targetHeight = Math.max(minHeight, Math.min(scrollHeight, maxHeight));
      textarea.style.height = `${targetHeight}px`;

      // Show scrollbar if content exceeds max height
      if (scrollHeight > maxHeight) {
        textarea.style.overflowY = 'auto';
      } else {
        textarea.style.overflowY = 'hidden';
      }
    };

    // Small delay to let framer animation complete
    const timeoutId = setTimeout(() => {
      adjustHeight();
    }, 200);

    // Adjust on mount and when value changes
    adjustHeight();

    // Watch for input changes
    textarea.addEventListener('input', adjustHeight);

    return () => {
      clearTimeout(timeoutId);
      textarea.removeEventListener('input', adjustHeight);
    };
  }, [isExpanded]);

  async function onSubmit(data: Parameters<typeof handleSubmit>[0]) {
    await handleSubmit(data, selectedProfileId);
  }

  return (
    <motion.div
      ref={containerRef}
      className={cn(
        'fixed',
        isStoriesRoute
          ? // Aligned with StoryContent: sidebar + list width + gap (tab bleeds with -mx-8)
            'left-[calc(5rem+360px+1.5rem)] right-8'
          : 'left-[calc(5rem+2rem)] right-8 lg:right-auto lg:w-[calc((100%-5rem-4rem)/2-1rem)]',
      )}
      style={{
        // On stories route: offset by track editor height when visible
        // On other routes: offset by audio player height when visible
        bottom: hasTrackEditor
          ? `${trackEditorHeight + 24}px`
          : isPlayerOpen
            ? 'calc(7rem + 1.5rem)'
            : '1.5rem',
      }}
    >
      <motion.div
        className="bg-background/30 backdrop-blur-2xl border border-accent/20 rounded-[2rem] shadow-2xl hover:bg-background/40 hover:border-accent/20 transition-all duration-300 p-3"
        transition={{ duration: 0.6, ease: 'easeInOut' }}
      >
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <div className="flex gap-2">
              <motion.div className="flex-1" transition={{ duration: 0.3, ease: 'easeOut' }}>
                <FormField
                  control={form.control}
                  name="text"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <motion.div
                          animate={{
                            height: isExpanded ? 'auto' : '32px',
                          }}
                          transition={{ duration: 0.15, ease: 'easeOut' }}
                          style={{ overflow: 'hidden' }}
                        >
                          {form.watch('engine') === 'chatterbox_turbo' ? (
                            <ParalinguisticInput
                              value={field.value}
                              onChange={field.onChange}
                              placeholder={
                                isStoriesRoute && currentStory
                                  ? t('generation.placeholder.storyWithEffects', {
                                      name: currentStory.name,
                                    })
                                  : selectedProfile
                                    ? t('generation.placeholder.effectsHint')
                                    : t('generation.placeholder.selectVoice')
                              }
                              className="px-3 py-2 resize-none bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none focus:ring-0 outline-none ring-0 rounded-2xl text-sm w-full"
                              style={{
                                minHeight: isExpanded ? '100px' : '32px',
                                maxHeight: '300px',
                                overflowY: 'auto',
                              }}
                              disabled={!selectedProfileId}
                              onClick={() => setIsExpanded(true)}
                              onFocus={() => setIsExpanded(true)}
                            />
                          ) : (
                            <Textarea
                              {...field}
                              ref={(node: HTMLTextAreaElement | null) => {
                                textareaRef.current = node;
                                if (typeof field.ref === 'function') {
                                  field.ref(node);
                                }
                              }}
                              placeholder={
                                isStoriesRoute && currentStory
                                  ? t('generation.placeholder.story', { name: currentStory.name })
                                  : selectedProfile
                                    ? t('generation.placeholder.profile', {
                                        name: selectedProfile.name,
                                      })
                                    : t('generation.placeholder.selectVoice')
                              }
                              className="resize-none bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none focus:ring-0 outline-none ring-0 rounded-2xl text-sm placeholder:text-muted-foreground/60 w-full"
                              style={{
                                minHeight: isExpanded ? '100px' : '32px',
                                maxHeight: '300px',
                              }}
                              disabled={!selectedProfileId}
                              onClick={() => setIsExpanded(true)}
                              onFocus={() => setIsExpanded(true)}
                            />
                          )}
                        </motion.div>
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </motion.div>

              <div className="flex items-start gap-2 shrink-0">
                <div className="group relative">
                  <Button
                    type="submit"
                    disabled={
                      isPending ||
                      !selectedProfileId ||
                      selectedProfile?.id !== selectedProfileId ||
                      !!expressionBlocked
                    }
                    title={expressionBlocked || undefined}
                    className="h-10 w-10 rounded-full bg-accent hover:bg-accent/90 hover:scale-105 text-accent-foreground shadow-lg hover:shadow-accent/50 transition-all duration-200"
                    size="icon"
                    aria-label={
                      isPending
                        ? t('generation.button.generating')
                        : !selectedProfileId
                          ? t('generation.button.selectFirst')
                          : t('generation.button.generate')
                    }
                  >
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                  </Button>
                  <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground border border-border opacity-0 transition-opacity group-hover:opacity-100 z-[9999]">
                    {isPending
                      ? t('generation.button.generating')
                      : !selectedProfileId
                        ? t('generation.button.selectFirst')
                        : t('generation.button.generate')}
                  </span>
                </div>
              </div>
            </div>

            <AnimatePresence>
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className=" mt-3"
              >
                <div className="flex items-center gap-2">
                  {showVoiceSelector && (
                    <div className="flex-1">
                      <Select
                        value={selectedProfileId || ''}
                        onValueChange={(value) => setSelectedProfileId(value || null)}
                      >
                        <SelectTrigger className="h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all w-full">
                          <SelectValue placeholder={t('generation.voiceSelector.placeholder')} />
                        </SelectTrigger>
                        <SelectContent side="top">
                          {profiles?.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id} className="text-xs">
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <FormField
                    control={form.control}
                    name="language"
                    render={({ field }) => {
                      const engineLangs = getLanguageOptionsForEngine(
                        form.watch('engine') || 'qwen',
                      );
                      return (
                        <FormItem className="flex-1 space-y-0">
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent side="top">
                              {engineLangs.map((lang) => (
                                <SelectItem key={lang.value} value={lang.value} className="text-xs">
                                  {lang.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage className="text-xs" />
                        </FormItem>
                      );
                    }}
                  />

                  <FormItem className="flex-1 space-y-0">
                    {expression.mode === 'natural' ? (
                      <EngineModelSelector form={form} compact />
                    ) : (
                      <div className="flex h-8 items-center rounded-full border border-border bg-card px-3 text-xs text-muted-foreground">
                        情绪配音
                      </div>
                    )}
                  </FormItem>

                  <FormItem className="flex-1 space-y-0">
                    <Select
                      value={selectedPresetId || 'none'}
                      onValueChange={(value) =>
                        setSelectedPresetId(value === 'none' ? null : value)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all">
                        <SelectValue placeholder={t('generation.effects.none')} />
                      </SelectTrigger>
                      <SelectContent side="top">
                        <SelectItem value="none" className="text-xs">
                          {t('generation.effects.none')}
                        </SelectItem>
                        {selectedProfile?.effects_chain &&
                          selectedProfile.effects_chain.length > 0 && (
                            <SelectItem value="_profile" className="text-xs">
                              {t('generation.effects.profileDefault')}
                            </SelectItem>
                          )}
                        {effectPresets?.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id} className="text-xs">
                            {preset.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                </div>
                <details className="mt-3 rounded-xl border border-border bg-card/60 px-3 py-2">
                  <summary className="cursor-pointer select-none text-xs text-muted-foreground">
                    表达方式{' '}
                    <span className="ml-2 font-medium text-foreground">
                      {expressionLabel(expression)}
                    </span>
                    {expression.mode !== 'natural' && expressionBlocked && (
                      <span className="ml-2">暂不可生成</span>
                    )}
                  </summary>
                  <div className="mt-3 max-h-[45vh] overflow-y-auto pb-1">
                    <ExpressionSettings
                      value={expression}
                      text={form.watch('text')}
                      disabled={isPending}
                      onChange={(value) => {
                        expressionEditedRef.current = true;
                        form.setValue('expression', value, { shouldDirty: true });
                      }}
                    />
                  </div>
                </details>
              </motion.div>
            </AnimatePresence>
          </form>
        </Form>
      </motion.div>
    </motion.div>
  );
}

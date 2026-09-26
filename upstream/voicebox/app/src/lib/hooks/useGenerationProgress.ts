import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { createGenerationStatusPoller } from '@/lib/generation-status-poller';
import { useGenerationSettings } from '@/lib/hooks/useSettings';
import { useGenerationStore } from '@/stores/generationStore';
import { usePlayerStore } from '@/stores/playerStore';
import { useServerStore } from '@/stores/serverStore';

// Agent-initiated generations are played by the floating pill, not the
// main-window AudioPlayer. Skip autoplay here to avoid double-playback.
const AGENT_SOURCES = new Set(['mcp', 'rest']);

/** Poll pending generations together without holding HTTP connections open. */
export function useGenerationProgress() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const { settings: genSettings } = useGenerationSettings();
  const autoplayRef = useRef(true);
  autoplayRef.current = genSettings?.autoplay_on_generate ?? true;

  useEffect(() => {
    const poller = createGenerationStatusPoller({
      getIds: () => [...useGenerationStore.getState().pendingGenerationIds],
      isVisible: () => document.visibilityState !== 'hidden',
      fetchStatuses: (ids, signal) => apiClient.getGenerationStatuses(ids, signal),
      onStatuses(statuses) {
        let historyChanged = false;
        for (const data of statuses) {
          const generation = useGenerationStore.getState();
          // A task may have been cancelled or removed while this request ran.
          if (!generation.pendingGenerationIds.has(data.id)) continue;
          if (data.status === 'completed') {
            generation.removePendingGeneration(data.id);
            historyChanged = true;
            const storyId = generation.removePendingStoryAdd(data.id);
            if (storyId) {
              apiClient
                .addStoryItem(storyId, { generation_id: data.id })
                .then(() => {
                  queryClient.invalidateQueries({ queryKey: ['stories'] });
                  queryClient.invalidateQueries({ queryKey: ['stories', storyId] });
                  toast({
                    title: 'Added to story',
                    description: data.duration
                      ? `Audio generated (${data.duration.toFixed(2)}s) and added to story`
                      : 'Audio generated and added to story',
                  });
                })
                .catch(() => {
                  toast({
                    title: 'Generation complete',
                    description: 'Audio generated but failed to add to story',
                    variant: 'destructive',
                  });
                });
            }

            const player = usePlayerStore.getState();
            const isAgentSpeak = data.source ? AGENT_SOURCES.has(data.source) : false;
            // A queued autoplay already owns the idle player while audio loads.
            // Several completions in one snapshot must not replace it repeatedly.
            if (
              autoplayRef.current &&
              !player.isPlaying &&
              !player.shouldAutoPlay &&
              !isAgentSpeak
            ) {
              player.setAudioWithAutoPlay(apiClient.getAudioUrl(data.id), data.id, '', '');
            }
          } else if (data.status === 'failed' || data.status === 'not_found') {
            generation.removePendingGeneration(data.id);
            generation.removePendingStoryAdd(data.id);
            historyChanged = true;
            toast({
              title: data.status === 'not_found' ? 'Generation not found' : 'Generation failed',
              description: data.error || 'An error occurred during generation',
              variant: 'destructive',
            });
          }
        }
        if (historyChanged) queryClient.refetchQueries({ queryKey: ['history'] });
      },
    });
    const unsubscribe = useGenerationStore.subscribe((state, previous) => {
      if (state.pendingGenerationIds !== previous.pendingGenerationIds) poller.refresh();
    });
    const onVisibilityChange = () => poller.refresh(true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      poller.dispose();
    };
  }, [queryClient, toast, serverUrl]);
}

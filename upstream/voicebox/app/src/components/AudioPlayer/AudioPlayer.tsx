import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Repeat, Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { apiClient } from '@/lib/api/client';
import {
  AudioLoadSession,
  audioSourceKey,
  createAudioProgressPublisher,
  fetchAudioBlob,
  isAudioReady,
  prepareAudioInstance,
} from '@/lib/audio-load-session';
import { formatAudioDuration } from '@/lib/utils/audio';
import { debug } from '@/lib/utils/debug';
import { usePlatform } from '@/platform/PlatformContext';
import { usePlayerStore } from '@/stores/playerStore';

function selectedKey() {
  const state = usePlayerStore.getState();
  return audioSourceKey(state.audioUrl, state.audioId);
}

export function AudioPlayer() {
  const platform = usePlatform();
  const volumeLabelId = useId();
  const {
    audioUrl,
    audioId,
    profileId,
    isPlaying,
    currentTime,
    duration,
    volume,
    isLooping,
    shouldRestart,
    shouldAutoPlay,
    setVolume,
    toggleLoop,
    clearRestartFlag,
    reset,
  } = usePlayerStore();
  const sourceKey = audioSourceKey(audioUrl, audioId);
  const profileChannelsQuery = useQuery({
    queryKey: ['profile-channels', profileId],
    queryFn: () =>
      profileId ? apiClient.getProfileChannels(profileId) : Promise.resolve({ channel_ids: [] }),
    enabled: !!profileId && platform.metadata.isTauri,
  });
  const profileChannels = profileChannelsQuery.data;
  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => apiClient.listChannels(),
    enabled: platform.metadata.isTauri && !!profileChannels?.channel_ids.length,
  });
  const channels = channelsQuery.data;
  const nativeDeviceIds = useMemo(() => {
    if (!platform.metadata.isTauri || !profileChannels || !channels) return [];
    return [
      ...new Set(
        channels
          .filter(
            (channel) => profileChannels.channel_ids.includes(channel.id) && !channel.is_default,
          )
          .flatMap((channel) => channel.device_ids),
      ),
    ];
  }, [platform.metadata.isTauri, profileChannels, channels]);
  const routingReady =
    !platform.metadata.isTauri ||
    !profileId ||
    (!profileChannelsQuery.isPending &&
      (!profileChannels?.channel_ids.length || !channelsQuery.isPending));
  const routingRef = useRef({ platform, nativeDeviceIds, ready: routingReady });
  routingRef.current = { platform, nativeDeviceIds, ready: routingReady };

  const [waveformNode, setWaveformNode] = useState<HTMLDivElement | null>(null);
  const [waveformRevision, setWaveformRevision] = useState(0);
  const failedSourceRef = useRef<string | null>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const loaderRef = useRef<AudioLoadSession | null>(null);
  const readyKeyRef = useRef<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const playbackRevision = useRef(0);
  const pendingPlayRef = useRef(false);
  const nativeActiveRef = useRef(false);
  const nativeTailRef = useRef<Promise<void>>(Promise.resolve());
  const finishHandledRef = useRef(false);
  const playRef = useRef<(restart?: boolean) => Promise<void>>(async () => {});
  const pauseRef = useRef<() => void>(() => {});
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopNative = useCallback(() => {
    if (!nativeActiveRef.current) return;
    nativeActiveRef.current = false;
    try {
      routingRef.current.platform.audio.stopPlayback();
    } catch (cause) {
      debug.error('Failed to stop native audio:', cause);
    }
  }, []);
  const interruptPlayback = useCallback(() => {
    playbackRevision.current += 1;
    pendingPlayRef.current = false;
    stopNative();
    wavesurferRef.current?.pause();
  }, [stopNative]);
  pauseRef.current = () => {
    interruptPlayback();
    usePlayerStore.getState().setIsPlaying(false);
  };
  playRef.current = async (restart = false) => {
    const wavesurfer = wavesurferRef.current;
    const key = readyKeyRef.current;
    const route = routingRef.current;
    if (!wavesurfer || !key || key !== selectedKey() || !route.ready) return;
    if (pendingPlayRef.current && !restart) return;
    if (wavesurfer.isPlaying() && !restart) return;
    const revision = ++playbackRevision.current;
    const current = () =>
      revision === playbackRevision.current &&
      key === readyKeyRef.current &&
      key === selectedKey() &&
      wavesurferRef.current === wavesurfer;
    pendingPlayRef.current = true;
    finishHandledRef.current = false;
    setError(null);
    usePlayerStore.getState().setIsPlaying(true);
    if (restart || wavesurfer.getCurrentTime() >= wavesurfer.getDuration() - 0.02)
      wavesurfer.seekTo(0);
    try {
      const blob = blobRef.current;
      if (route.nativeDeviceIds.length && blob) {
        // The device bridge has no seek/pause API. Preserve its existing whole-file
        // playback, serialize starts, and reuse the already fetched file.
        nativeTailRef.current = nativeTailRef.current
          .catch(() => {})
          .then(async () => {
            if (!current()) return;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (!current()) return;
            stopNative();
            nativeActiveRef.current = true;
            await route.platform.audio.playToDevices(bytes, route.nativeDeviceIds);
            if (!current()) {
              // close/pause may already have cleared the local active flag while
              // the bridge was still starting. Stop the late native start again.
              nativeActiveRef.current = false;
              route.platform.audio.stopPlayback();
            }
          });
        try {
          await nativeTailRef.current;
        } catch (cause) {
          if (!current()) return;
          stopNative();
          debug.error('Native audio unavailable; using browser playback:', cause);
        }
      }
      if (!current()) return;
      wavesurfer.setMuted(nativeActiveRef.current);
      wavesurfer.setVolume(usePlayerStore.getState().volume);
      await wavesurfer.play();
    } catch (cause) {
      // pause(), a new clip, and close can reject a pending HTMLMediaElement.play().
      if (!current()) return;
      stopNative();
      usePlayerStore.getState().setIsPlaying(false);
      setError(`无法播放音频：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      if (current()) pendingPlayRef.current = false;
    }
  };

  // Bind exactly to the rendered container. Closing removes it and destroys the
  // instance; reopening receives a new container. No hidden-container polling.
  useEffect(() => {
    if (!waveformNode) return;
    let wavesurfer: WaveSurfer;
    try {
      const color = (name: string) => {
        const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return value ? `hsl(${value})` : '';
      };
      wavesurfer = WaveSurfer.create({
        container: waveformNode,
        waveColor: color('--muted'),
        progressColor: color('--accent'),
        cursorColor: color('--accent'),
        cursorWidth: 3,
        barWidth: 2,
        barRadius: 2,
        height: 80,
        normalize: true,
        interact: true,
        dragToSeek: { debounceTime: 0 },
        mediaControls: false,
        // Native media playback avoids WebAudioPlayer fetching/decoding a second
        // buffer; WaveSurfer still decodes once for the waveform.
        backend: 'MediaElement',
      });
    } catch (cause) {
      setIsLoading(false);
      setError(`无法初始化播放器：${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    wavesurferRef.current = wavesurfer;
    let alive = true;
    const preparations = new Set<ReturnType<typeof prepareAudioInstance>>();
    const publishTime = createAudioProgressPublisher((time) =>
      usePlayerStore.getState().setCurrentTime(time),
    );
    const ready = () =>
      alive &&
      wavesurferRef.current === wavesurfer &&
      !!readyKeyRef.current &&
      readyKeyRef.current === selectedKey();
    const finish = () => {
      if (!ready() || finishHandledRef.current) return;
      finishHandledRef.current = true;
      stopNative();
      const state = usePlayerStore.getState();
      publishTime(state.duration, true);
      if (state.isLooping) void playRef.current(true);
      else {
        wavesurfer.pause();
        state.setIsPlaying(false);
        state.onFinish?.();
      }
    };
    const subscriptions = [
      wavesurfer.on('timeupdate', (time) => {
        if (!ready()) return;
        const state = usePlayerStore.getState();
        const end = state.duration;
        publishTime(end > 0 ? Math.min(time, end) : time);
        // Keep explicit segment ends without racing the full-track finish event.
        if (end > 0 && end < wavesurfer.getDuration() - 0.02 && time >= end) finish();
      }),
      wavesurfer.on('play', () => {
        if (!ready()) {
          wavesurfer.pause();
          return;
        }
        finishHandledRef.current = false;
        usePlayerStore.getState().setIsPlaying(true);
      }),
      wavesurfer.on('pause', () => {
        if (!ready()) return;
        const state = usePlayerStore.getState();
        state.setIsPlaying(false);
        publishTime(
          Math.min(wavesurfer.getCurrentTime(), state.duration || wavesurfer.getDuration()),
          true,
        );
      }),
      wavesurfer.on('seeking', (time) => {
        if (!ready()) return;
        finishHandledRef.current = false;
        publishTime(time, true);
      }),
      wavesurfer.on('finish', finish),
      wavesurfer.on('error', (cause) => {
        // Load failures are reported once by the request-bound promise below.
        // Only post-load playback errors belong to this unlabelled event.
        if (!ready()) return;
        pauseRef.current();
        setError(`无法播放音频：${cause instanceof Error ? cause.message : String(cause)}`);
      }),
    ];
    const loader = new AudioLoadSession({
      fetchBlob: fetchAudioBlob,
      loadBlob: (blob, source) => {
        const preparation = prepareAudioInstance(
          () => wavesurfer.loadBlob(blob),
          (listener) => wavesurfer.on('error', listener),
          (cause) => {
            if (!alive || wavesurferRef.current !== wavesurfer) return;
            alive = false;
            loaderRef.current?.dispose();
            readyKeyRef.current = null;
            blobRef.current = null;
            setReadyKey(null);
            interruptPlayback();
            if (source.key === selectedKey()) {
              failedSourceRef.current = source.key;
              setIsLoading(false);
              usePlayerStore.getState().setIsPlaying(false);
              usePlayerStore.getState().clearAutoPlayFlag();
              setError(`无法加载音频：${cause instanceof Error ? cause.message : String(cause)}`);
            }
            // A new DOM node retires the damaged media element. Keep the error
            // until retry/another clip, rather than automatically retrying bad data.
            setWaveformRevision((revision) => revision + 1);
          },
        );
        preparations.add(preparation);
        return preparation.promise.finally(() => {
          preparations.delete(preparation);
        });
      },
      onStart: () => {
        readyKeyRef.current = null;
        blobRef.current = null;
        setReadyKey(null);
        interruptPlayback();
        setIsLoading(true);
        setError(null);
        usePlayerStore.getState().setDuration(0);
        publishTime(0, true);
      },
      onReady: (source, blob) => {
        if (!alive || source.key !== selectedKey()) return;
        blobRef.current = blob;
        readyKeyRef.current = source.key;
        finishHandledRef.current = false;
        wavesurfer.setVolume(usePlayerStore.getState().volume);
        wavesurfer.setMuted(false);
        usePlayerStore.getState().setDuration(wavesurfer.getDuration());
        setError(null);
        setIsLoading(false);
        setReadyKey(source.key);
      },
      onError: (source, cause) => {
        if (!alive || source.key !== selectedKey()) return;
        setIsLoading(false);
        usePlayerStore.getState().setIsPlaying(false);
        usePlayerStore.getState().clearAutoPlayFlag();
        setError(`无法加载音频：${cause instanceof Error ? cause.message : String(cause)}`);
      },
    });
    loaderRef.current = loader;
    return () => {
      alive = false;
      loader.dispose();
      preparations.forEach((preparation) => {
        preparation.cancel();
      });
      preparations.clear();
      readyKeyRef.current = null;
      blobRef.current = null;
      interruptPlayback();
      subscriptions.forEach((unsubscribe) => {
        unsubscribe();
      });
      wavesurfer.destroy();
      if (wavesurferRef.current === wavesurfer) wavesurferRef.current = null;
      if (loaderRef.current === loader) loaderRef.current = null;
    };
  }, [waveformNode, interruptPlayback, stopNative]);

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader || !audioUrl || !sourceKey || !waveformNode) return;
    if (failedSourceRef.current === sourceKey) return;
    failedSourceRef.current = null;
    void loader.load({ key: sourceKey, url: audioUrl });
    return () => {
      loader.cancel();
      readyKeyRef.current = null;
      blobRef.current = null;
      interruptPlayback();
    };
  }, [audioUrl, sourceKey, waveformNode, interruptPlayback]);

  useEffect(() => {
    if (!isAudioReady(sourceKey, readyKey, readyKeyRef.current) || !routingReady) return;
    const state = usePlayerStore.getState();
    if (shouldRestart) {
      clearRestartFlag();
      state.clearAutoPlayFlag();
      void playRef.current(true);
    } else if (shouldAutoPlay) {
      state.clearAutoPlayFlag();
      void playRef.current();
    } else if (isPlaying) void playRef.current();
    else if (
      wavesurferRef.current?.isPlaying() ||
      pendingPlayRef.current ||
      nativeActiveRef.current
    )
      pauseRef.current();
  }, [
    readyKey,
    sourceKey,
    isPlaying,
    shouldAutoPlay,
    shouldRestart,
    routingReady,
    clearRestartFlag,
  ]);

  useEffect(() => {
    wavesurferRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      const target = event.target as HTMLElement;
      if (
        target?.isContentEditable ||
        target?.closest('input,textarea,select,button,a,[role="button"],[role="combobox"]')
      )
        return;
      if (!readyKeyRef.current || readyKeyRef.current !== selectedKey()) return;
      event.preventDefault();
      event.stopPropagation();
      if (usePlayerStore.getState().isPlaying) pauseRef.current();
      else void playRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  function handlePlayPause() {
    if (isLoading || !readyKeyRef.current) return;
    if (usePlayerStore.getState().isPlaying) pauseRef.current();
    else void playRef.current();
  }
  function handleSeek(value: number[]) {
    if (!readyKeyRef.current || readyKeyRef.current !== selectedKey()) return;
    wavesurferRef.current?.setTime(
      Math.max(0, Math.min(1, value[0] / 100)) * usePlayerStore.getState().duration,
    );
  }
  function handleVolumeChange(value: number[]) {
    setVolume(value[0] / 100);
  }
  function handleRetry() {
    const state = usePlayerStore.getState();
    const key = audioSourceKey(state.audioUrl, state.audioId);
    if (!state.audioUrl || !key || !loaderRef.current) return;
    failedSourceRef.current = null;
    if (state.audioId)
      state.setAudioWithAutoPlay(
        state.audioUrl,
        state.audioId,
        state.profileId,
        state.title || undefined,
      );
    void loaderRef.current.load({ key, url: state.audioUrl });
  }
  function handleClose() {
    failedSourceRef.current = null;
    loaderRef.current?.cancel();
    readyKeyRef.current = null;
    blobRef.current = null;
    interruptPlayback();
    setError(null);
    setIsLoading(false);
    setReadyKey(null);
    reset();
  }
  // Don't render if no audio
  if (!audioUrl) {
    return null;
  }

  return (
    <section
      aria-label="音频播放器"
      aria-busy={isLoading}
      className="fixed bottom-0 left-0 right-0 border-t bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60 z-50"
    >
      <div className="container mx-auto px-4 py-3 max-w-7xl">
        <div className="flex items-center gap-4">
          {/* Play/Pause Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handlePlayPause}
            disabled={isLoading || duration === 0}
            className={`shrink-0 -mt-2 ${isPlaying ? 'bg-accent text-accent-foreground' : ''}`}
            title={duration === 0 && !isLoading ? 'Audio not loaded' : ''}
            aria-label={
              duration === 0 && !isLoading ? 'Audio not loaded' : isPlaying ? 'Pause' : 'Play'
            }
          >
            {isPlaying ? (
              <Pause className="h-5 w-5 fill-current" />
            ) : (
              <Play className="h-5 w-5 fill-current" />
            )}
          </Button>

          {/* Waveform */}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div
              key={waveformRevision}
              ref={setWaveformNode}
              role="img"
              aria-label="音频波形"
              className="w-full min-h-[80px] select-none"
            />
            <Slider
              value={duration > 0 ? [(currentTime / duration) * 100] : [0]}
              onValueChange={handleSeek}
              max={100}
              step={0.1}
              className="w-full"
              aria-label="Playback position"
              aria-valuetext={`${formatAudioDuration(currentTime)} of ${formatAudioDuration(duration)}`}
            />

            {isLoading && (
              <output className="text-center text-xs text-muted-foreground">正在加载音频…</output>
            )}
            {error && (
              <div
                role="alert"
                className="flex items-center justify-center gap-2 py-2 text-xs text-destructive"
              >
                <span>{error}</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleRetry}>
                  重试
                </Button>
              </div>
            )}
          </div>

          {/* Time Display */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0 min-w-[100px]">
            <span className="font-mono">{formatAudioDuration(currentTime)}</span>
            <span>/</span>
            <span className="font-mono">{formatAudioDuration(duration)}</span>
          </div>

          {/* Loop Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleLoop}
            className={isLooping ? 'bg-accent text-accent-foreground' : ''}
            title="Toggle loop"
            aria-label={isLooping ? 'Stop looping' : 'Loop'}
          >
            <Repeat className="h-4 w-4" />
          </Button>

          {/* Volume Control */}
          <fieldset className="flex min-w-0 items-center gap-2 shrink-0 w-[120px] border-0 p-0">
            <legend className="sr-only">Volume</legend>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setVolume(volume > 0 ? 0 : 1)}
              className="h-8 w-8"
              aria-label={volume > 0 ? 'Mute' : 'Unmute'}
            >
              {volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
            <span id={volumeLabelId} className="sr-only">
              Volume level, {Math.round(volume * 100)}%
            </span>
            <Slider
              value={[volume * 100]}
              onValueChange={handleVolumeChange}
              max={100}
              step={1}
              className="flex-1"
              aria-labelledby={volumeLabelId}
              aria-valuetext={`${Math.round(volume * 100)}%`}
            />
          </fieldset>

          {/* Close Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="shrink-0"
            title="Close player"
            aria-label="Close player"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

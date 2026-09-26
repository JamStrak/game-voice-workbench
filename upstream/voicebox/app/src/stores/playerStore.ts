import { create } from 'zustand';

interface PlayerState {
  audioUrl: string | null;
  audioId: string | null;
  profileId: string | null;
  title: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isLooping: boolean;
  shouldRestart: boolean;
  shouldAutoPlay: boolean;
  onFinish: (() => void) | null;

  setAudio: (url: string, id: string, profileId: string | null, title?: string) => void;
  setAudioWithAutoPlay: (url: string, id: string, profileId: string | null, title?: string) => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setVolume: (volume: number) => void;
  toggleLoop: () => void;
  restartCurrentAudio: () => void;
  clearRestartFlag: () => void;
  clearAutoPlayFlag: () => void;
  setOnFinish: (callback: (() => void) | null) => void;
  reset: () => void;
}

/** Preview buttons only need this boolean, not the player's frame-by-frame progress. */
export function isAudioPlaying(state: Pick<PlayerState, 'audioId' | 'isPlaying'>, id: string) {
  return state.audioId === id && state.isPlaying;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  audioUrl: null,
  audioId: null,
  profileId: null,
  title: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isLooping: false,
  shouldRestart: false,
  shouldAutoPlay: false,
  onFinish: null,

  setAudio: (url, id, profileId, title) =>
    set({
      audioUrl: url,
      audioId: id,
      profileId: profileId || null,
      title: title || null,
      currentTime: 0,
      isPlaying: false,
      shouldRestart: false,
      shouldAutoPlay: false,
    }),
  setAudioWithAutoPlay: (url, id, profileId, title) =>
    set({
      audioUrl: url,
      audioId: id,
      profileId: profileId || null,
      title: title || null,
      currentTime: 0,
      isPlaying: false,
      shouldRestart: false,
      shouldAutoPlay: true,
    }),
  setIsPlaying: (playing) =>
    set((state) => (state.isPlaying === playing ? state : { isPlaying: playing })),
  setCurrentTime: (time) =>
    set((state) => (Object.is(state.currentTime, time) ? state : { currentTime: time })),
  setDuration: (duration) =>
    set((state) => (Object.is(state.duration, duration) ? state : { duration })),
  setVolume: (volume) => set((state) => (Object.is(state.volume, volume) ? state : { volume })),
  toggleLoop: () => set((state) => ({ isLooping: !state.isLooping })),
  restartCurrentAudio: () =>
    set((state) => (state.shouldRestart ? state : { shouldRestart: true })),
  clearRestartFlag: () => set((state) => (state.shouldRestart ? { shouldRestart: false } : state)),
  clearAutoPlayFlag: () =>
    set((state) => (state.shouldAutoPlay ? { shouldAutoPlay: false } : state)),
  setOnFinish: (callback) =>
    set((state) => (state.onFinish === callback ? state : { onFinish: callback })),
  reset: () =>
    set({
      audioUrl: null,
      audioId: null,
      profileId: null,
      title: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      isLooping: false,
      shouldRestart: false,
      shouldAutoPlay: false,
      onFinish: null,
    }),
}));

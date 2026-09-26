import type { EffectConfig, LibraryVoice, VoiceProfileResponse } from './api/types';

/** Publish a saved role to the selection list before navigating to its inspector. */
export function upsertProfileList(
  profiles: VoiceProfileResponse[] | undefined,
  saved: VoiceProfileResponse,
): VoiceProfileResponse[] {
  if (!profiles?.some((profile) => profile.id === saved.id)) return [saved, ...(profiles || [])];
  return profiles.map((profile) => (profile.id === saved.id ? saved : profile));
}

export function filterLibraryVoices(
  voices: LibraryVoice[],
  search: string,
  gender: string,
  tag: string,
): LibraryVoice[] {
  const query = search.trim().toLocaleLowerCase();
  return voices.filter(
    (voice) =>
      (!gender || voice.gender === gender) &&
      (!tag || voice.tags.includes(tag)) &&
      (!query ||
        [voice.name, voice.speaker, voice.description, voice.native_language, ...voice.tags]
          .join(' ')
          .toLocaleLowerCase()
          .includes(query)),
  );
}

/** Timbre adjustments are reusable post effects; the source voice remains unchanged. */
export function roleEffects(speed: number, pitch: number): EffectConfig[] {
  if (
    !Number.isFinite(speed) ||
    speed < 0.75 ||
    speed > 1.5 ||
    !Number.isFinite(pitch) ||
    pitch < -4 ||
    pitch > 4
  ) {
    throw new Error('请将语速设为 0.75–1.5 倍，音高设为 -4 到 +4 半音。');
  }
  return [
    ...(pitch === 0 ? [] : [{ type: 'pitch', enabled: true, params: { semitones: pitch } }]),
    ...(speed === 1 ? [] : [{ type: 'tempo', enabled: true, params: { speed } }]),
  ];
}

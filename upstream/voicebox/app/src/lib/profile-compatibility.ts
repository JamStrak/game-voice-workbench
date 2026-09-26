interface GenerationProfile {
  voice_type?: string | null;
  preset_engine?: string | null;
}

const PRESET_ENGINES = new Set(['kokoro', 'qwen_custom_voice']);

/** Expression synthesis can use either a Qwen preset reference or a cloned voice. */
export function isGenerationProfileSupported(
  profile: GenerationProfile,
  selectedEngine: string,
  emotionEnabled = false,
): boolean {
  const voiceType = profile.voice_type ?? 'cloned';
  if (emotionEnabled) {
    return (
      voiceType === 'cloned' ||
      (voiceType === 'preset' && profile.preset_engine === 'qwen_custom_voice')
    );
  }
  return PRESET_ENGINES.has(selectedEngine)
    ? voiceType === 'preset' && profile.preset_engine === selectedEngine
    : voiceType !== 'preset';
}

import{r as p,j as t,u as b,s as f}from"./index-CNMI7Ni-.js";const v=`<!-- This file is compiled automatically during the release workflow. -->\r
<!-- Do not edit manually — your changes will be overwritten. -->\r
<!-- To update the draft: ask the agent to use the draft-release-notes skill. -->\r
<!-- To finalize a release: ask the agent to use the release-bump skill. -->\r
\r
# Changelog\r
\r
## [Unreleased]\r
\r
### Linux\r
\r
- **ROCm setup works on Linux AMD systems.** Docker ROCm builds now keep PyTorch\r
  on the ROCm wheel index during dependency installation, so later installs do\r
  not replace it with CUDA wheels. The ROCm compose overlay no longer assumes\r
  Ubuntu render/video group IDs; the container joins the groups that own the GPU\r
  device nodes at startup. Native Linux setup now picks ROCm wheels for AMD GPUs\r
  and CUDA wheels for NVIDIA GPUs before installing backend dependencies.\r
\r
## [0.5.0] - 2026-04-22\r
\r
**The Capture release.** Voicebox stops being just a voice-cloning studio and becomes a full AI voice studio. Hold a key anywhere on your machine, speak, release — the transcript lands in the focused text field. Flip the primitive around and any MCP-aware agent — Claude Code, Cursor, Spacebot — speaks back through an on-screen pill in one of your cloned voices. A local LLM sits between the two, so transcripts come out clean and voice profiles can carry a personality that reshapes what the agent says before it gets spoken.\r
\r
### Dictation — speak anywhere, paste anywhere\r
\r
- **Global hotkey capture.** Hold a customizable chord anywhere on your machine (defaults: right-Cmd + right-Option on macOS, right-Ctrl + right-Shift on Windows), speak, release. A floating on-screen pill walks through recording → transcribing → refining → done with a live elapsed timer. The transcript lands as clean text.\r
- **Push-to-talk and toggle modes, each with its own chord.** The default toggle chord adds Space to the push-to-talk chord. Holding PTT and tapping Space mid-hold upgrades a hold into a hands-free session without a gap in the recording.\r
- **Auto-paste into the focused app.** Once transcription finishes, Voicebox synthesizes a paste into whatever text field had focus when you started the chord — not wherever focus drifted while you were talking. Works across Dvorak / AZERTY layouts. Your clipboard is saved before and restored after.\r
- **Chord picker UI.** Customize either chord from Settings → Captures by holding the keys you want. Left/right modifier badges show whether a key is the left or right variant.\r
- **Defaults stay out of your way.** macOS defaults avoid left-hand Cmd+Option chords so the system shortcuts they collide with stay yours. Windows defaults route around AltGr collisions on German / French / Spanish layouts.\r
- **Accessibility permission is scoped.** If macOS Accessibility isn't granted, dictation still runs and transcripts still land in the Captures tab — only synthetic paste is disabled. The permission prompt lives inline next to the auto-paste toggle, not as a global banner.\r
\r
### Personality — voice profiles that speak for themselves\r
\r
Voice profiles now carry an optional **personality** — a free-form description of who this voice is, up to 2000 characters. When set, two new controls appear next to the generate button, each powered by a new Qwen3 LLM running entirely locally:\r
\r
- **Compose** — the shuffle button drops a fresh in-character line into the textarea. Click again for variety, edit before speaking.\r
- **Speak in character** — the wand toggle runs your input through the personality LLM before TTS, preserving every idea but delivering it in the character's voice.\r
\r
The same LLM doubles as the refinement model, so there's one local LLM in the app, not two.\r
\r
**API surface.** \`POST /generate\`, \`POST /speak\`, and the MCP \`voicebox.speak\` tool accept \`personality: bool\`. \`POST /profiles/{id}/compose\` powers the shuffle button. MCP client bindings carry a \`default_personality: bool\` that applies when \`personality\` isn't passed explicitly.\r
\r
### Agents — any MCP-aware agent gets a voice\r
\r
Voicebox ships a built-in **Model Context Protocol** server at \`http://127.0.0.1:17493/mcp\` so Claude Code, Cursor, Windsurf, Cline, VS Code MCP extensions — any MCP-aware agent — can call into your local Voicebox install. Four tools ship with dotted names:\r
\r
- **\`voicebox.speak\`** — speak text in any voice profile, with optional \`personality: true\` to run through the profile's personality LLM first\r
- **\`voicebox.transcribe\`** — Whisper transcription of a base64 blob or an absolute local path. Path mode is restricted to loopback callers so a Voicebox bound on \`0.0.0.0\` doesn't double as an unauthenticated arbitrary-local-file read primitive.\r
- **\`voicebox.list_captures\`** — recent captures with their transcripts\r
- **\`voicebox.list_profiles\`** — available voice profiles (cloned + preset)\r
\r
- **Streamable HTTP as primary transport.** Cursor / Windsurf / VS Code / Claude Code all support it out of the box — drop a \`mcpServers\` block with the URL and an \`X-Voicebox-Client-Id\` header.\r
- **Stdio shim for clients that don't speak HTTP MCP.** A \`voicebox-mcp\` binary ships inside the app bundle as a Tauri sidecar. The Settings page renders the install snippet with the right absolute path pre-filled.\r
- **Per-client voice binding.** Pin Claude Code to Morgan, Cursor to Scarlett, Cline to its own voice — the \`X-Voicebox-Client-Id\` header resolves to a bound voice whenever \`speak\` is called without an explicit \`profile\`. Managed in **Settings → MCP**.\r
- **Profile resolution precedence.** Explicit \`profile\` arg (name or id, case-insensitive) → per-client binding → global default from \`capture_settings.default_playback_voice_id\` → error with a pointer to Settings.\r
- **Speaking pill.** Agent-initiated speech surfaces the same on-screen pill as dictation, in a \`speaking\` state with the profile name and an elapsed timer. Silent background TTS is a trust hazard — the pill always shows what's coming out of your machine.\r
- **\`POST /speak\` REST wrapper.** Same code path and voice resolution for shell scripts, ACP, A2A, GitHub Actions, or anything else that isn't MCP-native.\r
\r
**Claude Code one-liner:**\r
\r
\`\`\`\r
claude mcp add voicebox --transport http --url http://127.0.0.1:17493/mcp --header "X-Voicebox-Client-Id: claude-code"\r
\`\`\`\r
\r
### Refinement\r
\r
A clean transcript needs more than Whisper. Each capture flows through a small Qwen3 LLM that strips fillers, fixes punctuation, and optionally rewrites self-corrections — all on-device.\r
\r
- **Loop-stripping before the LLM sees the transcript.** Whisper's "thanks for watching thanks for watching thanks for watching…" hallucination loops are collapsed at a six-identical-tokens threshold (case-insensitive) so a small refinement model can't echo them back. Coverage spans single-word runs, multi-word phrases, CJK character runs, and Japanese emphasis patterns; legitimate repetition ("no, no, no, no, no") doesn't cross the threshold.\r
- **Per-capture flag snapshot.** \`smart_cleanup\`, \`self_correction\`, and \`preserve_technical\` are stored on each capture, so refinement can be re-run later with different flags without losing the raw transcript.\r
- **Model picker** — Qwen3 0.6B (400 MB, very fast), 1.7B (1.1 GB, fast), 4B (2.5 GB, full quality). 0.6B is the default; 1.7B is the sweet spot for transcripts with code identifiers.\r
\r
### Captures tab + settings\r
\r
Settings → Captures is now the home for the whole dictation flow:\r
\r
- **Dictation**: global shortcut toggle, push-to-talk chord picker, toggle chord picker, live pill preview, auto-paste into focused field (with inline accessibility prompt).\r
- **Transcription**: model picker (Whisper Base / Small / Medium / Large / Turbo), language lock.\r
- **Refinement**: auto-refine toggle, model picker, smart cleanup, remove self-corrections, preserve technical terms.\r
- **Playback**: default voice for the Captures tab's "Play as" action — picking a voice from the split-button persists the choice across tab switches and restarts.\r
- **Storage**: captures folder quick-open.\r
\r
### Stories — timeline editor\r
\r
The Stories tab graduates from a TTS sequencer into a real timeline editor. Same generation-row backing, but clips now compose with imported audio, per-clip levels, and a flexible track stack.\r
\r
- **Import external audio.** Drag a music file onto the story content area or pick one from the new "Import audio" entry in the add-clip popover. Accepted formats: wav / mp3 / flac / ogg / m4a / aac / webm, capped at 200 MB. Imported clips show their filename instead of a profile name and skip the regenerate / version-picker controls — there's nothing to regenerate.\r
- **Per-clip volume.** A \`Volume2\` icon in the clip-edit toolbar opens a 0–200% slider. Adjustments apply live and to exports. Split and duplicate carry the volume forward into the new clips.\r
- **Regenerate** from both the clip's chat-list dropdown and the track-editor toolbar. Re-runs the underlying generation through the same path the History tab uses, with completion tracked in the global pending set.\r
- **Add empty tracks above or below the timeline** via tiny \`+\` strips at the top of the topmost label cell and the bottom of the bottommost. Sticky in the label column so they follow horizontal scroll.\r
- **Zoom bar tracks the project.** Min scope is 10 seconds visible (zoomed in cap), max is the entire project (zoomed out cap), default lands on 60 s. Both the +/− buttons and the scrollbar edge-drag handles clamp to those dynamic bounds.\r
\r
### Interface\r
\r
- **Theme selector.** Light / dark / system in **Settings → General**, persisted across sessions. System mode listens for OS-level appearance changes and flips live without a restart.\r
- **Scrubbable waveform player on captures.** The capture detail card now embeds a WaveSurfer waveform with click-to-seek and a current / total timestamp pair, replacing the static duration label.\r
- **Capture pill light mode.** The on-screen pill gets a dedicated light palette so it stays legible against bright windows.\r
- **Readiness checklist in the Captures settings sidebar.** The same six-gate checklist the Captures empty state uses mirrors into Settings → Captures so a red gate can't hide behind a green toggle. Hidden once every gate is green. macOS-only rows (Input Monitoring, Accessibility) hide entirely on Windows and Linux.\r
\r
### Windows parity\r
\r
Same dictation flow on Windows. Right-hand default chord (Ctrl+Shift) avoids AltGr collisions on layouts where Ctrl+Alt is the compose key. Focus is captured at chord-start so paste lands in the original field even if focus drifts during transcribe/refine.\r
\r
## [0.4.5] - 2026-04-22\r
\r
Second hotfix for the "offline mode is enabled" crash on model load. 0.4.4 reverted the inference-path offline guards but kept the same trap on the load path, so users who updated to 0.4.4 kept hitting the exact error the release was supposed to fix ([#526](https://github.com/jamiepine/voicebox/issues/526)). This release removes the load-path guards and patches the transformers tokenizer load to be robust to HuggingFace metadata failures at the source, so the class of bug can't recur.\r
\r
### Reliability\r
\r
- **Load no longer fails with "offline mode is enabled"** ([#530](https://github.com/jamiepine/voicebox/pull/530), fixes [#526](https://github.com/jamiepine/voicebox/issues/526)). transformers 4.57.x added an unconditional \`huggingface_hub.model_info()\` call inside \`AutoTokenizer.from_pretrained\` (via \`_patch_mistral_regex\`) that runs for every non-local repo load, regardless of cache state or whether the target model is actually a Mistral variant. The load-time \`HF_HUB_OFFLINE\` guard from 0.4.2 turned that into a hard crash for cached online users the moment 0.4.4 removed the inference-path guard that had been masking the problem. Fix wraps \`_patch_mistral_regex\` so any exception from the HF metadata check is caught and the tokenizer is returned unchanged — matching the success-path behavior for non-Mistral repos. The wrapper installs at \`backend.backends\` import time so it covers Qwen Base, Qwen CustomVoice, TADA, and every other transformers-backed engine on Windows, Linux, and CUDA alike. The load-time \`force_offline_if_cached\` guards were removed — with the wrapper in place they provide zero value and only risk re-introducing the same failure mode.\r
- **No more 30s pause when generating without a network.** The HuggingFace metadata timeout called out as a known caveat in 0.4.4 is covered by the same patch; offline users no longer wait for the check to time out before load completes.\r
\r
## [0.4.4] - 2026-04-21\r
\r
Hotfix for a regression in 0.4.3 where generation and transcription could fail outright with "offline mode is enabled" even when the user was online.\r
\r
### Reliability\r
\r
- **Inference no longer fails with "offline mode is enabled" while online** ([#524](https://github.com/jamiepine/voicebox/pull/524), reverts the inference-path guards from [#503](https://github.com/jamiepine/voicebox/pull/503)). 0.4.3 wrapped every inference body (\`generate\`, \`transcribe\`, \`create_voice_clone_prompt\`) with a process-wide \`HF_HUB_OFFLINE\` flip to stop lazy HuggingFace lookups from hanging when the network drops mid-inference ([#462](https://github.com/jamiepine/voicebox/issues/462)). That flag also blocks legitimate metadata calls (e.g. \`HfApi().model_info\` for revision resolution) so online users started seeing generation fail outright. Inference now runs with the process's default HF state. Load-time offline guards — which weren't the source of the regression — stay in place.\r
\r
**Known caveat**: users generating without an internet connection may see brief pauses during inference while HuggingFace metadata lookups time out (typically ~30s, after which the library recovers). A proper offline-mode toggle is planned for 0.4.5.\r
\r
## [0.4.3] - 2026-04-20\r
\r
A patch focused on two user-impacting reliability fixes: macOS DMG notarization (unblocks \`brew install voicebox\` on macOS 15 Sequoia and fixes spurious "app isn't signed" Gatekeeper dialogs on older Intel Macs) and Kokoro Japanese voice initialization on fresh installs.\r
\r
### macOS\r
\r
- **DMGs are now notarized and stapled** ([#523](https://github.com/jamiepine/voicebox/pull/523)). Tauri's bundler notarizes the \`.app\` inside the DMG but ships the DMG wrapper itself unnotarized. Gatekeeper rejects that on macOS 15 Sequoia (confirmed by Homebrew Cask CI failing on both arm and intel Sequoia runners) and causes the "the app is not signed" dialog on older Intel Macs when Apple's notarization servers are slow or unreachable ([#509](https://github.com/jamiepine/voicebox/issues/509)). The release workflow now submits each DMG to \`notarytool\`, staples the ticket, verifies with \`spctl\`, and overwrites the draft-release asset \`tauri-action\` uploaded. Adds ~5-10 min per macOS job.\r
\r
### Backend\r
\r
- **Kokoro Japanese voices no longer crash on fresh installs** ([#521](https://github.com/jamiepine/voicebox/pull/521), fixes [#514](https://github.com/jamiepine/voicebox/issues/514)). \`misaki[ja]\` pulls in \`fugashi\`, which needs a MeCab dictionary on disk. The \`unidic\` package that was being installed ships no data and expects a ~526MB runtime download that \`just setup\` doesn't run (and which wouldn't survive PyInstaller anyway). Swapped to \`unidic-lite\`, which bundles a MeCab-compatible dict inside the wheel (~50MB). Collected in \`build_binary.py\` so frozen builds pick up \`unidic_lite/dicdir/\`.\r
\r
## [0.4.2] - 2026-04-20\r
\r
This release localizes the entire app. English, Simplified Chinese (zh-CN), Traditional Chinese (zh-TW), and Japanese (ja) are wired up end-to-end across every tab, modal, dialog, and toast — 559 translation keys per locale, parity verified. Plus a batch of reliability fixes: offline-mode now actually stays offline, Chatterbox accepts reference samples it used to reject, MLX Qwen 0.6B points at the right repo, and macOS system audio survives backgrounding.\r
\r
### Internationalization ([#508](https://github.com/jamiepine/voicebox/pull/508))\r
- **i18next foundation** with an in-app language switcher that re-renders the tree on change — lazy-loaded components were holding stale strings without an explicit key-bump on the React root.\r
- **Four locales** at full coverage: English, Simplified Chinese, Traditional Chinese, Japanese. No partial/English-fallback surfaces.\r
- **Every user-visible surface translated**: Stories (list, content editor, dialogs, toasts), Effects (list, detail, chain editor, built-in preset names), Voices (table, search, inspector, Create/Edit modal, audio sample panels), Audio Channels (list, dialogs, device picker), history + story dropdown menus, ProfileCard / ProfileList / HistoryTable, and the unsupported-model note.\r
- **Relative dates** localize via \`date-fns\` locale objects (\`3 days ago\` → \`3 天前\` / \`3 日前\`) — \`Intl.RelativeTimeFormat\` doesn't produce the phrasing we use in the history table.\r
- **Dev-build version suffix** (\`v0.4.2 (dev)\` / \`(开发版)\` / \`(開發版)\` / \`(開発版)\`) is now locale-aware.\r
- **559 translation keys** across all four locales.\r
\r
### Reliability\r
- **\`HF_HUB_OFFLINE\` now guards every inference path** ([#503](https://github.com/jamiepine/voicebox/pull/503)) — some engines were still attempting a HuggingFace metadata roundtrip on first load when offline mode was enabled, causing hangs on airgapped or flaky networks.\r
- **Chatterbox reference samples are preprocessed instead of rejected** ([#502](https://github.com/jamiepine/voicebox/pull/502)) — samples outside the expected sample rate or channel layout are resampled to match, rather than failing with an opaque error.\r
- **MLX Qwen 0.6B repo path fixed** ([#501](https://github.com/jamiepine/voicebox/pull/501)) — now points at the published \`mlx-community\` repo so the model actually downloads on Apple Silicon.\r
- **macOS system audio survives backgrounding** ([#486](https://github.com/jamiepine/voicebox/pull/486), closes [#41](https://github.com/jamiepine/voicebox/issues/41)) — WKWebView was tearing down the audio session when the app lost focus, silently killing system-audio capture.\r
- **MLX backend \`miniaudio\` dependency pinned** ([#506](https://github.com/jamiepine/voicebox/pull/506)) — \`mlx_audio.stt\` needs it at runtime and nothing else transitively pulled it in, so \`--no-deps\` installs were breaking on first use.\r
\r
### Landing / Docs\r
- **New \`/download\` page** ([#487](https://github.com/jamiepine/voicebox/pull/487)) — no more dumping first-time visitors onto the GitHub releases list. The API example snippet on the landing page also got an accuracy pass.\r
- **Download redirects work behind reverse proxies** ([#498](https://github.com/jamiepine/voicebox/pull/498)) — uses the public origin instead of \`localhost\` when resolving platform-specific installer URLs.\r
- **MDX docs audited against the multi-engine backend** ([#484](https://github.com/jamiepine/voicebox/pull/484)) — stale single-engine assumptions removed.\r
- **Three more tutorials + mobile navbar / hero CTA fixes** ([#483](https://github.com/jamiepine/voicebox/pull/483)).\r
\r
### Linux\r
- **Still not shipping.** The re-enable attempt ([#488](https://github.com/jamiepine/voicebox/pull/488)) landed on \`main\` but CI still hangs in the \`tauri-action\` bundler step on \`ubuntu-22.04\` — no output for 25+ minutes after \`rpm\` bundling, even with \`createUpdaterArtifacts: false\` and \`--bundles deb,rpm\`. The matrix entry is disabled again for 0.4.2; the ubuntu-specific setup steps stay in the workflow so re-enabling is a one-line change once we identify the hang. Next release will take another pass.\r
\r
### New Contributors\r
- [@shekharyv](https://github.com/shekharyv) — download redirects behind reverse proxies ([#498](https://github.com/jamiepine/voicebox/pull/498))\r
\r
## [0.4.1] - 2026-04-18\r
\r
A fast follow-up to 0.4.0 focused on making the new engines actually load in the production binary — plus generation cancellation, Linux system-audio capture, and the repo's first PR-time type check. Five first-time contributors shipped in this release.\r
\r
0.4.0 introduced three new TTS engines, but the frozen PyInstaller binary tripped over several Python-ecosystem quirks that don't show up in the dev venv: \`transformers\` opening \`.py\` sources at runtime, \`scipy.stats._distn_infrastructure\` hitting a frozen-importer \`NameError\`, and \`chatterbox-multilingual\` failing to find its Chinese segmenter dictionary. This release patches all of those in one sweep.\r
\r
### Frozen-Binary Reliability ([#438](https://github.com/jamiepine/voicebox/pull/438))\r
- **Kokoro** now bundles \`.py\` sources alongside \`.pyc\` via \`--collect-all kokoro\` so \`transformers\`' \`_can_set_attn_implementation\` regex scan can read them — previously \`FileNotFoundError: kokoro/modules.py\` killed Kokoro loading in production builds\r
- **Chatterbox Multilingual** now bundles \`spacy_pkuseg/dicts/default.pkl\` and the package's native \`.so\` extensions via \`--collect-all spacy_pkuseg\` — previously the Chinese word segmenter crashed with \`FileNotFoundError\` on first load\r
- **scipy.stats._distn_infrastructure** — new runtime hook source-patches the trailing \`del obj\` (which raises \`NameError\` under PyInstaller's frozen importer because the preceding list comprehension evaluates empty) to \`globals().pop('obj', None)\`, unblocking \`librosa\` → \`scipy.signal\` → \`scipy.stats\` for every TTS engine that depends on librosa\r
- **transformers.masking_utils** — same runtime hook forces \`_is_torch_greater_or_equal_than_2_6 = False\` so the older \`sdpa_mask_older_torch\` path is selected; the 2.6+ path uses \`TransformGetItemToIndex()\`, a real \`torch._dynamo\` graph transform our permissive stub can't reproduce\r
- **torch._dynamo** — no-op stub replaces the real module before \`transformers\` imports it, preventing the \`torch._numpy._ufuncs\` import crash (\`NameError: name 'name' is not defined\`) that blocked Kokoro and every engine pulling in \`flex_attention\`\r
- \`.spec\` paths are now repo-relative instead of absolute, so the generated spec is portable across machines and CI\r
\r
### Generation\r
- **Cancel queued or running generations** ([#444](https://github.com/jamiepine/voicebox/pull/444)) — new \`/generate/{id}/cancel\` endpoint and a Stop button on the history row while generating. The serial queue now tracks per-ID state (queued / running / cancelled) so queued jobs are skipped before the worker picks them up and running jobs are \`.cancel()\`-ed mid-flight; \`run_generation\` catches \`CancelledError\` and marks the row \`failed\` with a "cancelled" error.\r
- **Legacy \`data/\` path prefix resolution** ([#440](https://github.com/jamiepine/voicebox/pull/440)) — generations stored with the old \`data/\` prefix under pre-0.4 installs now resolve correctly after the storage root moved, fixing 404s for historical audio.\r
\r
### Model Migration\r
- Migration dialog no longer hangs when the cache is empty ([#439](https://github.com/jamiepine/voicebox/pull/439)) — the backend now emits a completion SSE event even when zero models are moved.\r
- Storage-change flow surfaces a toast when there's nothing to migrate ([#433](https://github.com/jamiepine/voicebox/pull/433)) instead of proceeding with a no-op move and restarting the server.\r
- Deleting all generations from a voice profile now deletes the associated version files and DB rows too ([#447](https://github.com/jamiepine/voicebox/pull/447)) — previously orphaned versions accumulated in storage.\r
\r
### Platform\r
- **Linux system audio capture** ([#457](https://github.com/jamiepine/voicebox/pull/457)) — \`cpal\`'s ALSA backend doesn't expose PulseAudio/PipeWire monitor sources by name, so the previous device-name search never matched and silently fell back to the microphone. Detection now uses \`pactl get-default-sink\` + \`pactl list short sources\` and routes via \`PULSE_SOURCE\`, with the name-based search retained as a fallback when \`pactl\` is absent.\r
\r
### Frontend CI\r
- First PR-time quality gate ([#418](https://github.com/jamiepine/voicebox/pull/418)) — new \`.github/workflows/ci.yml\` runs \`bun run typecheck\` + \`bun run build:web\` on every PR. Fixed pre-existing type issues that were being suppressed with \`@ts-expect-error\`, cleaned up a dep-array typo (\`[platform.metadata.isTauricheckOnMountcheckForUpdates]\`) in \`useAutoUpdater\`, and removed 100+ lines of dead \`ModelItem\` code from \`ModelManagement.tsx\`.\r
- Follow-up: widened \`apiClient.migrateModels()\` return type to include \`moved\` and \`errors\` so the storage-change handler typechecks against the real backend response ([#470](https://github.com/jamiepine/voicebox/pull/470)).\r
\r
### Docs\r
- Clarified in the Quick Start + README that paralinguistic tags (\`[laugh]\`, \`[sigh]\`) only work with Chatterbox Turbo; other engines read them as literal text ([#450](https://github.com/jamiepine/voicebox/pull/450)).\r
\r
### New Contributors\r
- [@Bortlesboat](https://github.com/Bortlesboat) — generation cancellation (#444)\r
- [@gaojulong](https://github.com/gaojulong) — migration dialog hang fix (#439)\r
- [@fuleinist](https://github.com/fuleinist) — migration no-op toast (#433)\r
- [@erionjuniordeandrade-a11y](https://github.com/erionjuniordeandrade-a11y) — frontend CI + type hardening (#418)\r
- [@estefrac](https://github.com/estefrac) — Linux pactl system-audio capture (#457)\r
\r
## [0.4.0] - 2026-04-16\r
\r
The biggest Voicebox release yet. Three new TTS engines bring the lineup to **seven** — HumeAI TADA, Kokoro 82M, and Qwen CustomVoice join Qwen3-TTS, LuxTTS, Chatterbox Multilingual, and Chatterbox Turbo. GPU support broadens to Intel Arc (XPU) and NVIDIA Blackwell (RTX 50-series), with runtime diagnostics that warn when your PyTorch build doesn't match your GPU. The CUDA backend is now split into independently versioned server and library archives, so upgrading no longer redownloads 4 GB of PyTorch/CUDA DLLs.\r
\r
This release also marks a big community moment: **13 new contributors** shipped fixes and features in 0.4.0. Thirty-plus bug fixes target the most-reported issues in the tracker — numpy 2.x TTS crashes, Windows background-server reliability, macOS 11 launch failures, audio playback silence, Stories clip-splitting races, history status staleness, and more.\r
\r
### New TTS Engines\r
\r
#### HumeAI TADA — Expressive English & Multilingual ([#296](https://github.com/jamiepine/voicebox/pull/296))\r
- Added \`tada-1b\` (English) and \`tada-3b-ml\` (multilingual) backends\r
- Replaced \`descript-audio-codec\` with a lightweight DAC shim to cut dependencies\r
- Switched audio decoding to \`soundfile\` to sidestep \`torchcodec\` bundling issues\r
- Redirected gated Llama tokenizer lookups to an ungated mirror so model loading works out of the box\r
- Fixed tokenizer patch that was corrupting \`AutoTokenizer\` for other engines\r
- Fixed TorchScript error in frozen builds\r
\r
#### Kokoro 82M — Fast Lightweight TTS ([#325](https://github.com/jamiepine/voicebox/pull/325))\r
- Added Kokoro 82M engine with a new voice profile type system that distinguishes preset voices from cloned profiles\r
- Profile grid now handles engine compatibility directly — removed redundant dropdown filtering\r
- Tightened Kokoro profile handling so preset voices can't be edited like cloned profiles\r
\r
#### Qwen CustomVoice ([#328](https://github.com/jamiepine/voicebox/pull/328))\r
- Added \`qwen-custom-voice\` preset engine backed by Qwen3-TTS\r
- Enforced preset/profile engine compatibility across the generation flow\r
- Floating generator now shows all engines instead of silently filtering\r
\r
### Voice Profile UX\r
\r
Until 0.4, every engine in Voicebox was a cloning model, so every voice profile was usable with every engine and the profile grid just showed them all. Introducing Kokoro and Qwen CustomVoice — which work from preset voices rather than cloned samples — broke that assumption for the first time. An early cut on \`main\` filtered the grid by the selected engine, which left users running pre-release builds thinking their cloned voices had vanished whenever they switched to a preset-only engine.\r
\r
This release ships the resolution before it ever reaches a tagged version:\r
\r
- **Grey-out instead of filter** — all profiles are always visible; unsupported ones render dimmed with a compatibility hint at the bottom of the grid\r
- **Auto-switch on selection** — clicking a greyed-out profile selects it AND switches the engine to a compatible one, instead of silently doing nothing\r
- **Instruct toggle restored for Qwen CustomVoice** — the floating generate box now reveals a delivery-instructions input (tone, emotion, pace) when CustomVoice is selected. Hidden across the board while the new multi-engine lineup was stabilizing because most engines don't honor the kwarg; now conditionally exposed only for the one engine that was actually trained for instruction-based style control\r
- Supported profiles sort first; the grid scrolls the selected profile into view after engine/sort changes\r
- Fixed engine desync on tab navigation — the form now initializes its engine from the store\r
- Fixed the disabled-and-selected card click edge case by bouncing selection to re-trigger the auto-switch\r
- Cleaned up scroll effect timers (requestAnimationFrame + setTimeout) to prevent stale DOM writes on unmount or rapid selection changes\r
\r
### GPU & Platform\r
\r
#### Intel Arc (XPU) Support ([#320](https://github.com/jamiepine/voicebox/pull/320))\r
- First-class Intel Arc support across all PyTorch-based backends\r
- Device-aware seeding, XPU detection in the GPU status panel, and setup flow detection\r
- Reports correct device name and VRAM in settings\r
\r
#### Blackwell / RTX 50-series Support ([#316](https://github.com/jamiepine/voicebox/pull/316), [#401](https://github.com/jamiepine/voicebox/pull/401))\r
- Upgraded the CUDA backend from cu126 → cu128 for RTX 50-series support\r
- Added \`sm_120+PTX\` to the CUDA build via \`TORCH_CUDA_ARCH_LIST\` for forward-compatibility with Blackwell architectures (closes 5 open reports: #386, #395, #396, #399, #400)\r
- GPU settings UI fixes around install/uninstall state\r
\r
#### GPU Compatibility Diagnostics ([#367](https://github.com/jamiepine/voicebox/pull/367), adapted)\r
- New \`check_cuda_compatibility()\` compares the current device's compute capability against the bundled PyTorch's architecture list\r
- Health endpoint exposes a \`gpu_compatibility_warning\` field so the UI can surface mismatches\r
- Startup logs a \`WARN\` when the installed PyTorch build doesn't support the detected GPU\r
- GPU status label shows \`[UNSUPPORTED - see logs]\` — no more silent "no kernel image" failures\r
\r
#### Split CUDA Backend ([#298](https://github.com/jamiepine/voicebox/pull/298))\r
- CUDA backend now ships as two independently versioned archives: a small server binary and a large libs archive (the ~4 GB of PyTorch/CUDA DLLs)\r
- Upgrading Voicebox no longer redownloads the libs archive when only the server binary changed\r
- Added \`asyncio.Lock\` around \`download_cuda_binary()\` so auto-update and manual download can't race on the same temp file ([#428](https://github.com/jamiepine/voicebox/pull/428))\r
- Updated \`package_cuda.py\` for PyInstaller 6.18 onedir layout\r
- Temp archives are always cleaned up on failure, even when the install aborts mid-extract\r
\r
### Bug Fixes\r
\r
#### Critical: TTS Generation\r
- **numpy 2.x \`torch.from_numpy\` crash** ([#361](https://github.com/jamiepine/voicebox/pull/361)) — torch compiled against numpy 1.x ABI fails silently when paired with numpy 2.x, causing \`RuntimeError: Numpy is not available\` / \`Unable to create tensor\` on every TTS request in bundled macOS Intel / Rosetta builds. Pinned \`numpy<2.0\` in requirements and added a PyInstaller runtime hook with a \`ctypes.memmove\` fallback as belt-and-suspenders. Hardened afterward to raise on unknown dtypes instead of silently reinterpreting bytes as float32.\r
\r
#### Platform Reliability\r
- **Windows background server** ([#402](https://github.com/jamiepine/voicebox/pull/402)) — "keep server running after close" now actually keeps the server running. The HTTP \`/watchdog/disable\` request could lose the race against process exit on Windows; added a \`.keep-running\` sentinel file as a synchronous fallback, with stale-sentinel cleanup on startup to avoid orphan server processes\r
- **macOS 11 launch crash** ([#424](https://github.com/jamiepine/voicebox/pull/424)) — weak-linked ScreenCaptureKit so the app can launch on macOS < 12.3 instead of crashing at dyld resolution. Gated system audio capture behind a real \`sw_vers\` version check so unsupported systems cleanly advertise "not available" rather than crashing at runtime\r
- **macOS Intel (x86_64) setup** ([#416](https://github.com/jamiepine/voicebox/pull/416)) — relaxed \`torch>=2.7.0\` → \`torch>=2.2.0\`. PyTorch dropped pre-built x86_64 wheels after 2.2.2, so Intel Mac devs could no longer \`pip install\`. Now resolves to the latest compatible torch per platform\r
- **Offline model loading** ([#318](https://github.com/jamiepine/voicebox/pull/318)) — Qwen TTS and Whisper force offline mode when loading cached models, so startup works without network access\r
- **GUI startup with external server** ([#319](https://github.com/jamiepine/voicebox/pull/319)) — fixed GUI launch when pointed at a remote/external server, and added data refresh on server switch; hardened health validation and error handling\r
- **Qwen3-TTS cache split on Windows** (adapted from [#218](https://github.com/jamiepine/voicebox/pull/218)) — route \`Qwen3TTSModel.from_pretrained\` through \`hf_constants.HF_HUB_CACHE\` so the speech tokenizer and \`preprocessor_config.json\` resolve from a single cache root\r
- **Qwen3-TTS bundling** ([#305](https://github.com/jamiepine/voicebox/pull/305)) — bundle \`qwen_tts\` source files in the PyInstaller build to fix \`inspect.getsource\` errors in frozen builds\r
- **Backend import paths** ([#345](https://github.com/jamiepine/voicebox/pull/345)) — moved lazy imports to top-level with absolute paths to resolve the "Failed to Save" preset error caused by \`ModuleNotFoundError\` in production builds\r
- **Effects service import** ([#384](https://github.com/jamiepine/voicebox/pull/384)) — fixed \`ModuleNotFoundError\` on preset create/update by switching to relative imports (#349)\r
\r
#### Audio & Playback\r
- **cpal stream silent playback** ([#405](https://github.com/jamiepine/voicebox/pull/405)) — \`cpal::Stream\` was dropped on function return immediately after \`play()\`, causing every playback to fall silent. Now holds the stream until either the buffer drains or the stop flag fires (#404)\r
\r
#### Stories & History\r
- **Clip-splitting race** ([#403](https://github.com/jamiepine/voicebox/pull/403)) — rapid double-clicks on split could race through \`split_story_item\` with inconsistent state. Added \`with_for_update()\` row locking on the backend and an \`isPending\` guard on the frontend (#366)\r
- **History \`status\` staleness** ([#394](https://github.com/jamiepine/voicebox/pull/394)) — \`GET /history/{id}\` was hardcoding \`status="completed"\` regardless of the DB row, breaking any client polling for job completion. Now returns \`status\`, \`error\`, \`engine\`, \`model_size\`, and \`is_favorited\` from the actual row\r
- **"Clear failed" bulk button** ([#412](https://github.com/jamiepine/voicebox/pull/412)) — new \`DELETE /history/failed\` endpoint and a header strip showing \`"N failed generations"\` with a Clear button, complementing the per-row trash icon added in #321 (#410)\r
- **Delete failed generations** ([#321](https://github.com/jamiepine/voicebox/pull/321)) — added a trash icon next to the retry button so failed entries can be cleaned up without having to retry first\r
\r
#### Security & Safety\r
- **Voice prompt cache hardening** ([#429](https://github.com/jamiepine/voicebox/pull/429)) — \`torch.load(weights_only=True)\` on cached voice prompts per PyTorch 2.6 recommendation; replaced string-based SPA path guard with \`Path.is_relative_to()\` for more robust path-traversal protection\r
\r
#### Infrastructure & Docker\r
- **Docker web build** ([#344](https://github.com/jamiepine/voicebox/pull/344)) — include \`CHANGELOG.md\` in the Docker web build so the in-app changelog page works in Docker deployments\r
- **Docker numba cache** ([#425](https://github.com/jamiepine/voicebox/pull/425)) — set \`NUMBA_CACHE_DIR\` in docker-compose so numba can write its JIT cache in container runtime (#308)\r
- **Relative media paths** ([#332](https://github.com/jamiepine/voicebox/pull/332)) — media paths now stored relative to the configured data dir rather than resolved against CWD, so the data directory is portable between installs\r
\r
### Developer Tooling\r
\r
- New \`triage-prs\` agent skill — encodes the end-to-end PR-speedrun workflow (classification → triage doc → rebase → squash-merge → follow-ups) so future release cycles can reproduce it\r
- Rewrote the TTS engine guide with the patterns learned from adding TADA and Kokoro\r
- Added the API refactor plan and CUDA libs addon design doc\r
- Fixed broken links in the Get Started section ([#332](https://github.com/jamiepine/voicebox/pull/332))\r
\r
### New Contributors\r
\r
Huge thank you to everyone who contributed their first PR to Voicebox in this release:\r
\r
[@liorshahverdi](https://github.com/liorshahverdi), [@nicoschtein](https://github.com/nicoschtein), [@ArfianID](https://github.com/ArfianID), [@aimaaaimaa](https://github.com/aimaaaimaa), [@maxmcoding](https://github.com/maxmcoding), [@Khalodddd](https://github.com/Khalodddd), [@LuisSambrano](https://github.com/LuisSambrano), [@shaun0927](https://github.com/shaun0927), [@malletfils](https://github.com/malletfils), [@mvanhorn](https://github.com/mvanhorn), [@kuishou68](https://github.com/kuishou68), [@txhno](https://github.com/txhno), [@MukundaKatta](https://github.com/MukundaKatta)\r
\r
## [0.3.0] - 2026-03-17\r
\r
This release rewrites the backend into a modular architecture, overhauls the settings UI into routed sub-pages, fixes audio player freezing, migrates documentation to Fumadocs, and ships a batch of bug fixes targeting the most-reported issues from the tracker.\r
\r
The backend's 3,000-line monolith \`main.py\` has been decomposed into domain routers, a services layer, and a proper database package. A style guide and ruff configuration now enforce consistency. On the frontend, settings have been split into dedicated routed pages with server logs, a changelog viewer, and an about page. The audio player no longer freezes mid-playback, and model loading status is now visible in the UI. Seven user-reported bugs have been fixed, including server crashes during sample uploads, generation list staleness, cryptic error messages, and CUDA support for RTX 50-series GPUs.\r
\r
### Settings Overhaul ([#294](https://github.com/jamiepine/voicebox/pull/294))\r
- Split settings into routed sub-tabs: General, Generation, GPU, Logs, Changelog, About\r
- Added live server log viewer with auto-scroll\r
- Added in-app changelog page that parses \`CHANGELOG.md\` at build time\r
- Added About page with version info, license, and generation folder quick-open\r
- Extracted reusable \`SettingRow\` component for consistent setting layouts\r
\r
### Audio Player Fix ([#293](https://github.com/jamiepine/voicebox/pull/293))\r
- Fixed audio player freezing during playback\r
- Improved playback UX with better state management and listener cleanup\r
- Fixed restart race condition during regeneration\r
- Added stable keys for audio element re-rendering\r
- Improved accessibility across player controls\r
\r
### Backend Refactor ([#285](https://github.com/jamiepine/voicebox/pull/285))\r
- Extracted all routes from \`main.py\` into 13 domain routers under \`backend/routes/\` — \`main.py\` dropped from ~3,100 lines to ~10\r
- Moved CRUD and service modules into \`backend/services/\`, platform detection into \`backend/utils/\`\r
- Split monolithic \`database.py\` into a \`database/\` package with separate \`models\`, \`session\`, \`migrations\`, and \`seed\` modules\r
- Added \`backend/STYLE_GUIDE.md\` and \`pyproject.toml\` with ruff linting config\r
- Removed dead code: unused \`_get_cuda_dll_excludes\`, stale \`studio.py\`, \`example_usage.py\`, old \`Makefile\`\r
- Deduplicated shared logic across TTS backends into \`backends/base.py\`\r
- Improved startup logging with version, platform, data directory, and database stats\r
- Fixed startup database session leak — sessions now rollback and close in \`finally\` block\r
- Isolated shutdown unload calls so one backend failure doesn't block the others\r
- Handled null duration in \`story_items\` migration\r
- Reject model migration when target is a subdirectory of source cache\r
\r
### Documentation Rewrite ([#288](https://github.com/jamiepine/voicebox/pull/288))\r
- Migrated docs site from Mintlify to Fumadocs (Next.js-based)\r
- Rewrote introduction and root page with content from README\r
- Added "Edit on GitHub" links and last-updated timestamps on all pages\r
- Generated OpenAPI spec and auto-generated API reference pages\r
- Removed stale planning docs (\`CUDA_BACKEND_SWAP\`, \`EXTERNAL_PROVIDERS\`, \`MLX_AUDIO\`, \`TTS_PROVIDER_ARCHITECTURE\`, etc.)\r
- Sidebar groups now expand by default; root redirects to \`/docs\`\r
- Added OG image metadata and \`/og\` preview page\r
\r
### UI & Frontend\r
- Added model loading status indicator and effects preset dropdown ([3187344](https://github.com/jamiepine/voicebox/commit/3187344))\r
- Fixed take-label race condition during regeneration\r
- Added accessible focus styling to select component\r
- Softened select focus indicator opacity\r
- Addressed 4 critical and 12 major issues from CodeRabbit review\r
\r
### Bug Fixes ([#295](https://github.com/jamiepine/voicebox/pull/295))\r
- Fixed sample uploads crashing the server — audio decoding now runs in a thread pool instead of blocking the async event loop ([#278](https://github.com/jamiepine/voicebox/issues/278))\r
- Fixed generation list not updating when a generation completes — switched to \`refetchQueries\` for reliable cache busting, added SSE error fallback, and page reset on completion ([#231](https://github.com/jamiepine/voicebox/issues/231))\r
- Fixed error toasts showing \`[object Object]\` instead of the actual error message ([#290](https://github.com/jamiepine/voicebox/issues/290))\r
- Added Whisper model selection (\`base\`, \`small\`, \`medium\`, \`large\`, \`turbo\`) and expanded language support to the \`/transcribe\` endpoint ([#233](https://github.com/jamiepine/voicebox/issues/233))\r
- Upgraded CUDA backend build from cu121 to cu126 for RTX 50-series (Blackwell) GPU support ([#289](https://github.com/jamiepine/voicebox/issues/289))\r
- Handled client disconnects in SSE and streaming endpoints to suppress \`[Errno 32] Broken Pipe\` errors ([#248](https://github.com/jamiepine/voicebox/issues/248))\r
- Fixed Docker build failure from pip hash mismatch on Qwen3-TTS dependencies ([#286](https://github.com/jamiepine/voicebox/issues/286))\r
- Added 50 MB upload size limit with chunked reads to prevent unbounded memory allocation on sample uploads\r
- Eliminated redundant double audio decode in sample processing pipeline\r
\r
### Platform Fixes\r
- Replaced \`netstat\` with \`TcpStream\` + PowerShell for Windows port detection ([#277](https://github.com/jamiepine/voicebox/pull/277))\r
- Fixed Docker frontend build and cleaned up Docker docs\r
- Fixed macOS download links to use \`.dmg\` instead of \`.app.tar.gz\`\r
- Added dynamic download redirect routes to landing site\r
\r
### Release Tooling\r
- Added \`draft-release-notes\` and \`release-bump\` agent skills\r
- Wired CI release workflow to extract notes from \`CHANGELOG.md\` for GitHub Releases\r
- Backfilled changelog with all historical releases\r
\r
## [0.2.3] - 2026-03-15\r
\r
The "it works in dev but not in prod" release. This version fixes a series of PyInstaller bundling issues that prevented model downloading, loading, generation, and progress tracking from working in production builds.\r
\r
### Model Downloads Now Actually Work\r
\r
The v0.2.1/v0.2.2 builds could not download or load models that weren't already cached from a dev install. This release fixes the entire chain:\r
\r
- **Chatterbox, Chatterbox Turbo, and LuxTTS** all download, load, and generate correctly in bundled builds\r
- **Real-time download progress** — byte-level progress bars now work in production. The root cause: \`huggingface_hub\` silently disables tqdm progress bars based on logger level, which prevented our progress tracker from receiving byte updates. We now force-enable the internal counter regardless.\r
- **Fixed Python 3.12.0 \`code.replace()\` bug** — the macOS build was on Python 3.12.0, which has a [known CPython bug](https://github.com/pyinstaller/pyinstaller/issues/7992) that corrupts bytecode when PyInstaller rewrites code objects. This caused \`NameError: name 'obj' is not defined\` crashes during scipy/torch imports. Upgraded to Python 3.12.13.\r
\r
### PyInstaller Fixes\r
\r
- Collect all \`inflect\` files — \`typeguard\`'s \`@typechecked\` decorator calls \`inspect.getsource()\` at import time, which needs \`.py\` source files, not just bytecode. Fixes LuxTTS "could not get source code" error.\r
- Collect all \`perth\` files — bundles the pretrained watermark model (\`hparams.yaml\`, \`.pth.tar\`) needed by Chatterbox at runtime\r
- Collect all \`piper_phonemize\` files — bundles \`espeak-ng-data/\` (phoneme tables, language dicts) needed by LuxTTS for text-to-phoneme conversion\r
- Set \`ESPEAK_DATA_PATH\` in frozen builds so the espeak-ng C library finds the bundled data instead of looking at \`/usr/share/espeak-ng-data/\`\r
- Collect all \`linacodec\` files — fixes \`inspect.getsource\` error in Vocos codec\r
- Collect all \`zipvoice\` files — fixes source code lookup in LuxTTS voice cloning\r
- Copy metadata for \`requests\`, \`transformers\`, \`huggingface-hub\`, \`tokenizers\`, \`safetensors\`, \`tqdm\` — fixes \`importlib.metadata\` lookups in frozen binary\r
- Add hidden imports for \`chatterbox\`, \`chatterbox_turbo\`, \`luxtts\`, \`zipvoice\` backends\r
- Add \`multiprocessing.freeze_support()\` to fix resource_tracker subprocess crash in frozen binary\r
- \`--noconsole\` now only applied on Windows — macOS/Linux need stdout/stderr for Tauri sidecar log capture\r
- Hardened \`sys.stdout\`/\`sys.stderr\` devnull redirect to test writability, not just \`None\` check\r
\r
### Updater\r
\r
- Fixed updater artifact generation with \`v1Compatible\` for \`tauri-action\` signature files\r
- Updated \`tauri-action\` to v0.6 to fix updater JSON and \`.sig\` generation\r
\r
### Other Fixes\r
\r
- Full traceback logging on all backend model loading errors (was just \`str(e)\` before)\r
\r
## [0.2.2] - 2026-03-15\r
\r
- Fix Chatterbox model support in bundled builds\r
- Fix LuxTTS/ZipVoice support in bundled builds\r
- Auto-update CUDA binary when app version changes\r
- CUDA download progress bar\r
- Fix server process staying alive on macOS (SIGHUP handling, watchdog grace period)\r
- Hide console window when running CUDA binary on Windows\r
\r
## [0.2.1] - 2026-03-15\r
\r
Voicebox v0.1.x was a single-engine voice cloning app built around Qwen3-TTS. v0.2.0 is a ground-up rethink: four TTS engines, 23 languages, paralinguistic emotion controls, a post-processing effects pipeline, unlimited generation length, an async generation queue, and support for every major GPU vendor. Plus Docker.\r
\r
### New TTS Engines\r
\r
#### Multi-Engine Architecture\r
\r
Voicebox now runs **four independent TTS engines** behind a thread-safe per-engine backend registry. Switch engines per-generation from a single dropdown — no restart required.\r
\r
| Engine                      | Languages | Size    | Key Strengths                                 |\r
| --------------------------- | --------- | ------- | --------------------------------------------- |\r
| **Qwen3-TTS 1.7B**          | 10        | ~3.5 GB | Highest quality, delivery instructions        |\r
| **Qwen3-TTS 0.6B**          | 10        | ~1.2 GB | Lighter, faster variant                       |\r
| **LuxTTS**                  | English   | ~300 MB | CPU-friendly, 48 kHz output, 150x realtime    |\r
| **Chatterbox Multilingual** | 23        | ~3.2 GB | Broadest language coverage, zero-shot cloning |\r
| **Chatterbox Turbo**        | English   | ~1.5 GB | 350M params, low latency, paralinguistic tags |\r
\r
#### Chatterbox Multilingual — 23 Languages ([#257](https://github.com/jamiepine/voicebox/pull/257))\r
\r
Zero-shot voice cloning in Arabic, Chinese, Danish, Dutch, English, Finnish, French, German, Greek, Hebrew, Hindi, Italian, Japanese, Korean, Malay, Norwegian, Polish, Portuguese, Russian, Spanish, Swahili, Swedish, and Turkish.\r
\r
#### LuxTTS — Lightweight English TTS ([#254](https://github.com/jamiepine/voicebox/pull/254))\r
\r
A fast, CPU-friendly English engine. ~300 MB download, 48 kHz output, runs at 150x realtime on CPU.\r
\r
#### Chatterbox Turbo — Expressive English ([#258](https://github.com/jamiepine/voicebox/pull/258))\r
\r
A fast 350M-parameter English model with inline paralinguistic tags.\r
\r
#### Paralinguistic Tags Autocomplete ([#265](https://github.com/jamiepine/voicebox/pull/265))\r
\r
Type \`/\` in the text input with Chatterbox Turbo selected to open an autocomplete for **9 expressive tags**: \`[laugh]\` \`[chuckle]\` \`[gasp]\` \`[cough]\` \`[sigh]\` \`[groan]\` \`[sniff]\` \`[shush]\` \`[clear throat]\`\r
\r
### Generation\r
\r
#### Unlimited Generation Length — Auto-Chunking ([#266](https://github.com/jamiepine/voicebox/pull/266))\r
\r
Long text is now automatically split at sentence boundaries, generated per-chunk, and crossfaded back together. Engine-agnostic.\r
\r
- Auto-chunking limit slider — 100–5,000 chars (default 800)\r
- Crossfade slider — 0–200ms (default 50ms)\r
- Max text length raised to 50,000 characters\r
- Smart splitting respects abbreviations, CJK punctuation, and \`[tags]\`\r
\r
#### Asynchronous Generation Queue ([#269](https://github.com/jamiepine/voicebox/pull/269))\r
\r
Generation is now fully non-blocking. Serial execution queue prevents GPU contention. Real-time SSE status streaming.\r
\r
#### Generation Versions\r
\r
Every generation now supports multiple versions with provenance tracking — original, effects versions, takes, source tracking, version pinning in stories, and favorites.\r
\r
### Post-Processing Effects ([#271](https://github.com/jamiepine/voicebox/pull/271))\r
\r
A full audio effects system powered by Spotify's \`pedalboard\` library: Pitch Shift, Reverb, Delay, Chorus/Flanger, Compressor, Gain, High-Pass Filter, Low-Pass Filter. 4 built-in presets, custom presets, per-profile default effects, and live preview.\r
\r
### Platform Support\r
\r
- **Windows Support** ([#272](https://github.com/jamiepine/voicebox/pull/272)) — Full Windows support with CUDA GPU detection\r
- **Linux** ([#262](https://github.com/jamiepine/voicebox/pull/262)) — AMD ROCm, NVIDIA GBM fix, WebKitGTK mic access (build from source)\r
- **NVIDIA CUDA Backend Swap** ([#252](https://github.com/jamiepine/voicebox/pull/252)) — Download and swap in CUDA backend from within the app\r
- **Intel Arc (XPU) and DirectML** — PyTorch backend supports Intel Arc and DirectML\r
- **Docker + Web Deployment** ([#161](https://github.com/jamiepine/voicebox/pull/161)) — 3-stage build, non-root runtime, health checks\r
- **Whisper Turbo** — Added \`openai/whisper-large-v3-turbo\` as a transcription model option\r
\r
### Model Management ([#268](https://github.com/jamiepine/voicebox/pull/268))\r
\r
Per-model unload, custom models directory, model folder migration, download cancel/clear UI ([#238](https://github.com/jamiepine/voicebox/pull/238)), restructured settings UI.\r
\r
### Security & Reliability\r
\r
- CORS hardening ([#88](https://github.com/jamiepine/voicebox/pull/88))\r
- Network access toggle ([#133](https://github.com/jamiepine/voicebox/pull/133))\r
- Offline crash fix ([#152](https://github.com/jamiepine/voicebox/pull/152))\r
- Atomic audio saves ([#263](https://github.com/jamiepine/voicebox/pull/263))\r
- Filesystem health endpoint\r
- Chatterbox float64 dtype fix ([#264](https://github.com/jamiepine/voicebox/pull/264))\r
\r
### Accessibility ([#243](https://github.com/jamiepine/voicebox/pull/243))\r
\r
Screen reader support, keyboard navigation, state-aware \`aria-label\` attributes on all interactive controls.\r
\r
### UI Polish\r
\r
- Redesigned landing page ([#274](https://github.com/jamiepine/voicebox/pull/274))\r
- Voices tab overhaul with inline inspector\r
- Responsive layout improvements\r
- Duplicate profile name validation ([#175](https://github.com/jamiepine/voicebox/pull/175))\r
\r
### Community Contributors\r
\r
[@haosenwang1018](https://github.com/haosenwang1018), [@Balneario-de-Cofrentes](https://github.com/Balneario-de-Cofrentes), [@ageofalgo](https://github.com/ageofalgo), [@mikeswann](https://github.com/mikeswann), [@rayl15](https://github.com/rayl15), [@mpecanha](https://github.com/mpecanha), [@ways2read](https://github.com/ways2read), [@ieguiguren](https://github.com/ieguiguren), [@Vaibhavee89](https://github.com/Vaibhavee89), [@pandego](https://github.com/pandego), [@luminest-llc](https://github.com/luminest-llc)\r
\r
## [0.1.13] - 2026-02-23\r
\r
### Stability and reliability\r
\r
- [#95](https://github.com/jamiepine/voicebox/pull/95) Fix: selecting 0.6B model still downloads and uses 1.7B\r
- [#93](https://github.com/jamiepine/voicebox/pull/93) fix(mlx): bundle native libs and broaden error handling for Apple Silicon\r
- [#79](https://github.com/jamiepine/voicebox/pull/79) fix: handle non-ASCII filenames in Content-Disposition headers\r
- [#78](https://github.com/jamiepine/voicebox/pull/78) fix: guard getUserMedia call against undefined mediaDevices in non-secure contexts\r
- [#77](https://github.com/jamiepine/voicebox/pull/77) fix: await for confirmation before deleting voices and channels\r
- [#128](https://github.com/jamiepine/voicebox/pull/128) fix: resolve multiple issues (#96, #119, #111, #108, #121, #125, #127)\r
- [#40](https://github.com/jamiepine/voicebox/pull/40) Fix: audio export path resolution\r
\r
### Build and packaging\r
\r
- [#122](https://github.com/jamiepine/voicebox/pull/122) fix(web): add @tailwindcss/vite plugin to web config\r
- [#126](https://github.com/jamiepine/voicebox/pull/126) Create requirements.txt\r
\r
### UX and docs\r
\r
- [#44](https://github.com/jamiepine/voicebox/pull/44) Enhances floating generate box UX\r
- [#57](https://github.com/jamiepine/voicebox/pull/57) chore: updates repo URL in README\r
- [#146](https://github.com/jamiepine/voicebox/pull/146) Add Spacebot banner to landing page\r
- [#1](https://github.com/jamiepine/voicebox/pull/1) Improvements\r
\r
## [0.1.12] - 2026-01-31\r
\r
### Model Download UX Overhaul\r
\r
- Real-time download progress tracking with accurate percentage and speed info\r
- No more downloading notifications during generation even when its not downloading\r
- Better error handling and status reporting throughout the download process\r
\r
### Other Improvements\r
\r
- Enhanced health check endpoint with GPU type information\r
- Improved model caching verification\r
- More reliable SSE progress updates\r
- Actual update notifications — no need to manually check in settings anymore\r
\r
## [0.1.11] - 2026-01-30\r
\r
- Fixed transcriptions on MLX\r
- Fixed model download progress (finally)\r
\r
## [0.1.10] - 2026-01-30\r
\r
### Faster generation on Apple Silicon\r
\r
Massive speed gains, from around 20s per generation to 2-3s. Added native MLX backend support for Apple Silicon, providing significantly faster TTS and STT generation on M-series macOS machines.\r
\r
- **MLX Backend** — New backend implementation optimized for Apple Silicon using MLX framework\r
- **Dynamic Backend Selection** — Automatically detects platform and selects between MLX (macOS) and PyTorch (other platforms)\r
- Refactored TTS and STT logic into modular backend implementations\r
- Updated build process to include MLX-specific dependencies for macOS builds\r
\r
## [0.1.9] - 2026-01-30\r
\r
### Improved voice profile creation flow\r
\r
- Voice create drafts: No longer lose work if you close the modal\r
- Fixed whisper only transcribing English or Chinese, now has support for all languages\r
\r
### Improved Stories editor\r
\r
- Added spacebar for play/pause\r
- Timeline now auto-scrolls to follow playhead during playback\r
- Fixed misalignment of the items with mouse when picking up\r
- Fixed hitbox for selecting an item\r
- Fixed playhead jumping forward when pressing play\r
\r
### Generation box improvements\r
\r
- Instruct mode no longer wipes prompt text\r
- Improved UI cleanliness\r
\r
### Misc\r
\r
- Fixed "Model downloading" toast during generation when model is already downloaded\r
\r
## [0.1.8] - 2026-01-29\r
\r
### Model Download Timeout Issues\r
\r
Fixed critical issue where model downloads would fail with "Failed to fetch" errors on Windows. Refactored download endpoints to return immediately and continue downloads in background.\r
\r
### Cross-Platform Cache Path Issues\r
\r
Fixed hardcoded \`~/.cache/huggingface/hub\` paths that don't work on Windows. All cache paths now use \`hf_constants.HF_HUB_CACHE\` for proper cross-platform support.\r
\r
### Windows Process Management\r
\r
- Added \`/shutdown\` endpoint for graceful server shutdown on Windows\r
- Added \`gpu_type\` field to health check response\r
\r
## [0.1.7] - 2026-01-29\r
\r
- Trim and split audio clips in Story Editor\r
- Auto-activation of stories in Story Editor with visible playhead\r
- Conditional auto-play support in AudioPlayer for better user control\r
- Refactored audio loading across HistoryTable, SampleList, and generation forms\r
- Audio now only auto-plays when explicitly intended, preventing unexpected playback\r
\r
## [0.1.6] - 2026-01-29\r
\r
### Introducing Stories\r
\r
A full voice editor for composing podcasts and generated conversations.\r
\r
- **Stories Editor** — Create multi-voice narratives, podcasts, or conversations with a timeline-based editor\r
- Compose tracks with different voices\r
- Edit and arrange audio segments inline\r
- Build generated conversations with multiple participants\r
- **Improved Voice Generation UI** — Auto-resizing input, default voice selection, better layout\r
- **Track Editor Integration** — Inline track editing within story items\r
\r
## [0.1.5] - 2026-01-28\r
\r
Fixed recording length limit at 0:29 to auto stop instead of passing the limit and getting an error, which would cause users to lose their recording.\r
\r
## [0.1.4] - 2026-01-28\r
\r
- Audio channel management system\r
- Native audio playback handling in AudioPlayer component\r
- Refactored ConnectionForm and Checkbox components\r
- Improved layout consistency and responsiveness\r
- Added safe area constants for better responsive design\r
\r
## [0.1.3] - 2026-01-27\r
\r
- Improved the generate textbox\r
- Maybe fixed Windows autoupdate restarting entire computer\r
\r
## [0.1.2] - 2026-01-27\r
\r
### Audio Capture & Format Conversion\r
\r
- Added audio format conversion util\r
- Enhanced system audio capture on macOS and Windows\r
- Improved audio recording hooks\r
- Added audio input entitlement for macOS\r
- Added audio capture tests\r
\r
### Update System\r
\r
- Enhanced auto-updater functionality and update status display\r
\r
## [0.1.1] - 2026-01-27\r
\r
### Platform Support\r
\r
- **macOS Audio Capture** — Native audio capture support for sample creation\r
- **Windows Audio Capture** — WASAPI implementation with improved thread safety\r
- **Linux Support** — Temporarily removed builds due to runner disk space constraints\r
\r
### Audio Features\r
\r
- Play/pause for audio samples across all components\r
- Three new sample components: Recording, System capture, Upload with drag-and-drop\r
- Audio validation, error handling, and consistent cleanup\r
\r
### Voice Profile Management\r
\r
- Profile import with file size validation (100MB limit)\r
- Enhanced profile form with new audio sample components\r
- Drag-and-drop support for audio file uploads\r
\r
### Server Management\r
\r
- Changed default URL from \`localhost:8000\` to \`127.0.0.1:17493\`\r
- Server reuse logic, "keep server running" preference, orphaned process handling\r
\r
### Build & Release\r
\r
- Added \`.bumpversion.cfg\` for automated version management\r
- Enhanced icon generation script for multi-size Windows icons\r
\r
### Bug Fixes\r
\r
- Fixed date formatting for timezone-less date strings\r
- Fixed getLatestRelease file filtering\r
- Improved audio duration metadata on Windows\r
\r
## [0.1.0] - 2026-01-27\r
\r
The first public release of Voicebox — an open-source voice synthesis studio powered by Qwen3-TTS.\r
\r
### Voice Cloning with Qwen3-TTS\r
\r
- Automatic model download from HuggingFace\r
- Multiple model sizes (1.7B and 0.6B)\r
- Voice prompt caching for instant regeneration\r
- English and Chinese support\r
\r
### Voice Profile Management\r
\r
- Create profiles from audio files or record directly in the app\r
- Multiple samples per profile for higher quality cloning\r
- Import/Export profiles\r
- Automatic transcription via Whisper\r
\r
### Speech Generation\r
\r
- Simple text-to-speech with profile selection\r
- Seed control for reproducible generations\r
- Long-form support up to 5,000 characters\r
\r
### Generation History\r
\r
- Full history with metadata\r
- Search by text content\r
- Inline playback and download\r
\r
### Flexible Deployment\r
\r
- Local mode with bundled backend\r
- Remote mode for GPU servers on your network\r
- One-click server setup\r
\r
### Desktop Experience\r
\r
- Built with Tauri v2 (Rust) — native performance, not Electron\r
- Cross-platform: macOS and Windows\r
- No Python installation required\r
\r
### Tech Stack\r
\r
Tauri v2, React, TypeScript, Tailwind CSS, FastAPI, Qwen3-TTS, Whisper, SQLite\r
\r
[0.5.0]: https://github.com/jamiepine/voicebox/compare/v0.4.5...v0.5.0\r
[0.4.5]: https://github.com/jamiepine/voicebox/compare/v0.4.4...v0.4.5\r
[0.4.4]: https://github.com/jamiepine/voicebox/compare/v0.4.3...v0.4.4\r
[0.4.3]: https://github.com/jamiepine/voicebox/compare/v0.4.2...v0.4.3\r
[0.4.2]: https://github.com/jamiepine/voicebox/compare/v0.4.1...v0.4.2\r
[0.4.1]: https://github.com/jamiepine/voicebox/compare/v0.4.0...v0.4.1\r
[0.4.0]: https://github.com/jamiepine/voicebox/compare/v0.3.0...v0.4.0\r
[0.3.0]: https://github.com/jamiepine/voicebox/compare/v0.2.3...v0.3.0\r
[0.2.3]: https://github.com/jamiepine/voicebox/compare/v0.2.2...v0.2.3\r
[0.2.2]: https://github.com/jamiepine/voicebox/compare/v0.2.1...v0.2.2\r
[0.2.1]: https://github.com/jamiepine/voicebox/compare/v0.1.13...v0.2.1\r
[0.1.13]: https://github.com/jamiepine/voicebox/compare/v0.1.12...v0.1.13\r
[0.1.12]: https://github.com/jamiepine/voicebox/compare/v0.1.11...v0.1.12\r
[0.1.11]: https://github.com/jamiepine/voicebox/compare/v0.1.10...v0.1.11\r
[0.1.10]: https://github.com/jamiepine/voicebox/compare/v0.1.9...v0.1.10\r
[0.1.9]: https://github.com/jamiepine/voicebox/compare/v0.1.8...v0.1.9\r
[0.1.8]: https://github.com/jamiepine/voicebox/compare/v0.1.7...v0.1.8\r
[0.1.7]: https://github.com/jamiepine/voicebox/compare/v0.1.6...v0.1.7\r
[0.1.6]: https://github.com/jamiepine/voicebox/compare/v0.1.5...v0.1.6\r
[0.1.5]: https://github.com/jamiepine/voicebox/compare/v0.1.4...v0.1.5\r
[0.1.4]: https://github.com/jamiepine/voicebox/compare/v0.1.3...v0.1.4\r
[0.1.3]: https://github.com/jamiepine/voicebox/compare/v0.1.2...v0.1.3\r
[0.1.2]: https://github.com/jamiepine/voicebox/compare/v0.1.1...v0.1.2\r
[0.1.1]: https://github.com/jamiepine/voicebox/compare/v0.1.0...v0.1.1\r
[0.1.0]: https://github.com/jamiepine/voicebox/releases/tag/v0.1.0\r
`;function w(r){var a;const e=[],i=r.replace(/^\[[\w.]+\]:.*$/gm,"").trimEnd(),o=/^## \[(.+?)\](?:\s*-\s*(.+))?$/gm,n=[...i.matchAll(o)];for(let s=0;s<n.length;s++){const l=n[s],d=l[1],h=((a=l[2])==null?void 0:a.trim())||null,u=l.index+l[0].length,m=s+1<n.length?n[s+1].index:i.length,g=i.slice(u,m).trim();e.push({version:d,date:h,body:g})}return e}function y(r){const e=r.split(`
`),i=[];let o=0;for(;o<e.length;){const n=e[o];if(n.trim()===""){o++;continue}if(n.trim().startsWith("|")){const a=[];for(;o<e.length&&e[o].trim().startsWith("|");)a.push(e[o]),o++;i.push(x(a,i.length));continue}if(n.startsWith("#### ")){i.push(t.jsx("h5",{className:"text-sm font-medium mt-5 mb-1",children:c(n.slice(5))},i.length)),o++;continue}if(n.startsWith("### ")){i.push(t.jsx("h4",{className:"text-sm font-medium mt-6 mb-2",children:c(n.slice(4))},i.length)),o++;continue}if(n.startsWith("- ")){const a=[];for(;o<e.length&&e[o].startsWith("- ");)a.push(e[o].slice(2)),o++;i.push(t.jsx("ul",{className:"space-y-1 my-2",children:a.map((s,l)=>t.jsxs("li",{className:"text-sm text-muted-foreground flex gap-2",children:[t.jsx("span",{className:"text-muted-foreground/50 select-none shrink-0",children:"•"}),t.jsx("span",{children:c(s)})]},l))},i.length));continue}i.push(t.jsx("p",{className:"text-sm text-muted-foreground my-2",children:c(n)},i.length)),o++}return i}function x(r,e){const i=a=>a.split("|").slice(1,-1).map(s=>s.trim()),o=i(r[0]),n=r.slice(2).map(i);return t.jsx("div",{className:"overflow-x-auto my-3",children:t.jsxs("table",{className:"text-sm w-full",children:[t.jsx("thead",{children:t.jsx("tr",{className:"border-b",children:o.map((a,s)=>t.jsx("th",{className:"text-left py-1.5 pr-4 text-muted-foreground font-medium text-xs",children:c(a)},s))})}),t.jsx("tbody",{children:n.map((a,s)=>t.jsx("tr",{className:"border-b border-border/50",children:a.map((l,d)=>t.jsx("td",{className:"py-1.5 pr-4 text-muted-foreground",children:c(l)},d))},s))})]})},e)}function c(r){const e=[],i=/\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;let o=0,n=i.exec(r);for(;n!==null;)n.index>o&&e.push(r.slice(o,n.index)),n[1]!==void 0?e.push(t.jsx("strong",{className:"font-medium text-foreground",children:n[1]},e.length)):n[2]!==void 0?e.push(t.jsx("code",{className:"px-1 py-0.5 rounded bg-muted text-xs font-mono",children:n[2]},e.length)):n[3]!==void 0&&n[4]!==void 0&&e.push(t.jsx("a",{href:n[4],target:"_blank",rel:"noopener noreferrer",className:"text-accent hover:underline",children:n[3]},e.length)),o=n.index+n[0].length,n=i.exec(r);return o<r.length&&e.push(r.slice(o)),e.length===1?e[0]:e}function k({entry:r}){const{t:e}=b(),[i,o]=p.useState(!1),n=p.useMemo(()=>y(r.body),[r.body]),a=r.body.split(`
`).length>12;return t.jsxs("div",{className:"border-b border-border/50 pb-6",children:[t.jsxs("div",{className:"flex items-baseline gap-3 mb-3",children:[t.jsx("h3",{className:"text-xl font-semibold tracking-tight",children:r.version}),r.date&&t.jsx("span",{className:"text-xs text-muted-foreground",children:r.date}),r.version==="Unreleased"&&t.jsx(f,{variant:"outline",children:e("settings.changelog.devBadge")})]}),t.jsxs("div",{className:a&&!i?"max-h-48 overflow-hidden relative":"",children:[n,a&&!i&&t.jsx("div",{className:"absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent"})]}),a&&t.jsx("button",{onClick:()=>o(!i),className:"text-xs text-accent hover:underline mt-2",children:e(i?"settings.changelog.showLess":"settings.changelog.showMore")})]})}function S(){const r=p.useMemo(()=>w(v),[]);return t.jsx("div",{className:"space-y-6 max-w-2xl",children:r.map(e=>t.jsx(k,{entry:e},e.version))})}export{S as ChangelogPage};

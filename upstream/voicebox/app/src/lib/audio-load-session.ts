export interface AudioSource {
  key: string;
  url: string;
}

interface AudioLoadPort {
  fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob>;
  loadBlob: (blob: Blob, source: AudioSource) => Promise<void>;
  onStart: (source: AudioSource) => void;
  onReady: (source: AudioSource, blob: Blob) => void;
  onError: (source: AudioSource, error: unknown) => void;
}

/**
 * WaveSurfer 7 can finish an old decode after a newer load and emit an unlabelled ready.
 * Serialize its non-cancellable decode, abort superseded downloads, and publish only
 * the latest selection. Intermediate queued selections never fetch or decode.
 */
export class AudioLoadSession {
  private revision = 0;
  private disposed = false;
  private controller: AbortController | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly port: AudioLoadPort) {}

  load(source: AudioSource): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.cancel();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const current = () =>
      !this.disposed && this.revision === revision && !controller.signal.aborted;
    this.port.onStart(source);
    this.tail = this.tail.then(async () => {
      if (!current()) return;
      try {
        const blob = await this.port.fetchBlob(source.url, controller.signal);
        if (!current()) return;
        await this.port.loadBlob(blob, source);
        if (current()) this.port.onReady(source, blob);
      } catch (error) {
        // Only cancellation we requested is expected. Real errors in the current
        // load, including an unexpected AbortError, remain visible and retryable.
        if (current()) this.port.onError(source, error);
      }
    });
    return this.tail;
  }

  cancel(): void {
    this.revision += 1;
    this.controller?.abort();
    this.controller = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

export function audioSourceKey(url: string | null, id: string | null): string | null {
  return url ? JSON.stringify([url, id]) : null;
}

/** React may retain a previous ready render while a reopened media instance loads. */
export function isAudioReady(
  sourceKey: string | null,
  renderedReadyKey: string | null,
  instanceReadyKey: string | null,
): boolean {
  return !!sourceKey && sourceKey === renderedReadyKey && sourceKey === instanceReadyKey;
}

export async function fetchAudioBlob(
  url: string,
  signal: AbortSignal,
  timeoutMs = 15000,
): Promise<Blob> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`读取音频失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('试听文件为空，请重新生成或选择其他版本。');
    return blob;
  } catch (cause) {
    if (timedOut && !signal.aborted) throw new Error('音频加载超时，请检查本地服务后重试。');
    throw cause;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/** WaveSurfer animates independently; React needs a progress update only every 100 ms. */
export function createAudioProgressPublisher(
  publish: (time: number) => void,
  now: () => number = () => performance.now(),
) {
  let previous = Number.NEGATIVE_INFINITY;
  return (time: number, force = false) => {
    const timestamp = now();
    if (!force && timestamp - previous < 100) return;
    previous = timestamp;
    publish(time);
  };
}

/**
 * WaveSurfer waits for loadedmetadata without rejecting media errors. A failed
 * preparation must retire that instance before rejecting; otherwise a later
 * metadata event can revive the old load and overlap the next decode.
 */
export function prepareAudioInstance(
  load: () => Promise<void>,
  listenError: (listener: (error: unknown) => void) => () => void,
  retire: (error: unknown) => void,
  timeoutMs = 15000,
): { promise: Promise<void>; cancel: () => void } {
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const complete = (error?: unknown, fatal = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    unsubscribe?.();
    if (error !== undefined) {
      try {
        if (fatal) retire(error);
      } finally {
        reject(error);
      }
    } else resolve();
  };
  unsubscribe = listenError((error) => complete(error, true));
  timer = setTimeout(
    () => complete(new Error('音频准备超时，请重试或选择其他音频。'), true),
    timeoutMs,
  );
  // Defer so callers can register cleanup before a synchronous load failure.
  Promise.resolve()
    .then(() => {
      if (settled) return;
      return load();
    })
    .then(
      () => complete(),
      (error) => complete(error, true),
    );
  return {
    promise,
    cancel: () => complete(new DOMException('Audio preparation cancelled', 'AbortError')),
  };
}

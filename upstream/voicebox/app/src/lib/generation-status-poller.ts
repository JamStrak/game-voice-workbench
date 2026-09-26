import type { GenerationStatusEvent } from './api/client';

interface PollerOptions {
  getIds: () => readonly string[];
  isVisible: () => boolean;
  fetchStatuses: (ids: string[], signal: AbortSignal) => Promise<GenerationStatusEvent[]>;
  onStatuses: (statuses: GenerationStatusEvent[]) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

/** One bounded request at a time, with no idle or hidden-tab connections. */
export function createGenerationStatusPoller({
  getIds,
  isVisible,
  fetchStatuses,
  onStatuses,
  intervalMs = 2_000,
  timeoutMs = 10_000,
}: PollerOptions) {
  let stopped = false;
  let running = false;
  let resumeImmediately = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function canPoll() {
    return !stopped && isVisible() && getIds().length > 0;
  }

  function schedule(delay: number) {
    clearTimer();
    if (!canPoll()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
  }

  async function poll() {
    if (running || !canPoll()) return;
    running = true;
    resumeImmediately = false;
    try {
      const ids = [...new Set(getIds())];
      // The endpoint accepts 100 IDs. Large queues are split serially, never
      // into one connection per task or multiple concurrent batch requests.
      for (let offset = 0; offset < ids.length && canPoll(); offset += 100) {
        const pending = new Set(getIds());
        const batch = ids.slice(offset, offset + 100).filter((id) => pending.has(id));
        if (!batch.length) continue;
        const request = new AbortController();
        controller = request;
        const timeout = setTimeout(() => request.abort(), timeoutMs);
        try {
          const statuses = await fetchStatuses(batch, request.signal);
          if (!request.signal.aborted && canPoll()) onStatuses(statuses);
        } finally {
          clearTimeout(timeout);
          if (controller === request) controller = undefined;
        }
      }
    } catch {
      // A transient network error or timeout says nothing about task status.
      // Keep pending IDs and deferred story actions intact for the next poll.
    } finally {
      running = false;
      schedule(resumeImmediately ? 0 : intervalMs);
    }
  }

  function refresh(immediate = false) {
    if (stopped) return;
    if (!canPoll()) {
      clearTimer();
      controller?.abort();
      return;
    }
    if (immediate) {
      clearTimer();
      resumeImmediately = true;
    }
    if (!running && timer === undefined) schedule(0);
  }

  refresh();
  return {
    refresh,
    dispose() {
      stopped = true;
      clearTimer();
      controller?.abort();
    },
  };
}

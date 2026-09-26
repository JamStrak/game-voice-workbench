import type { PlatformLifecycle, ServerLogEntry } from '@/platform/types';

class WebLifecycle implements PlatformLifecycle {
  onServerReady?: () => void;

  async startServer(_remote = false, _modelsDir?: string | null): Promise<string> {
    // Web assumes server is running externally
    const serverUrl = window.location.origin;
    this.onServerReady?.();
    return serverUrl;
  }

  async stopServer(): Promise<void> {
    // No-op for web - server is managed externally
  }

  async restartServer(_modelsDir?: string | null): Promise<string> {
    // No-op for web - server is managed externally
    return window.location.origin;
  }

  async setKeepServerRunning(_keep: boolean): Promise<void> {
    // No-op for web
  }

  async setBackendOverride(_backend?: string | null): Promise<void> {
    // No-op for web - backend variant is managed externally
  }

  async setupWindowCloseHandler(): Promise<void> {
    // No-op for web - no window close handling needed
  }

  subscribeToServerLogs(_callback: (_entry: ServerLogEntry) => void): () => void {
    // No-op for web - server logs are not available
    return () => {};
  }
}

export const webLifecycle = new WebLifecycle();

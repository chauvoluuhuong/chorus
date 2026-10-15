import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface PtySpawnOptions {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
}

export class PtyClient {
  private isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__);
  private eventSource: EventSource | null = null;
  private unlistenData: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  private dataListeners: ((chunk: string) => void)[] = [];
  private exitListeners: ((code: number) => void)[] = [];
  public currentId: string | null = null;

  async spawn(options: PtySpawnOptions): Promise<void> {
    this.currentId = options.id;

    if (this.isTauri) {
      await invoke('spawn_pty', { options });

      this.unlistenData = await listen<{ id: string; data: string }>('pty:data', event => {
        if (event.payload.id === options.id) {
          this.dataListeners.forEach(fn => fn(event.payload.data));
        }
      });

      this.unlistenExit = await listen<{ id: string; exit_code: number }>('pty:exit', event => {
        if (event.payload.id === options.id) {
          this.exitListeners.forEach(fn => fn(event.payload.exit_code));
        }
      });
    } else {
      // Dev / Test mode via Vite PTY Bridge
      const res = await fetch('/api/pty/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to spawn PTY' }));
        throw new Error(err.error || 'Failed to spawn PTY');
      }

      // Open SSE stream
      this.eventSource = new EventSource(`/api/pty/stream?id=${encodeURIComponent(options.id)}`);

      this.eventSource.onmessage = e => {
        try {
          const text = JSON.parse(e.data);
          this.dataListeners.forEach(fn => fn(text));
        } catch {
          this.dataListeners.forEach(fn => fn(e.data));
        }
      };

      this.eventSource.addEventListener('exit', (e: MessageEvent) => {
        try {
          const { code } = JSON.parse(e.data);
          this.exitListeners.forEach(fn => fn(code));
        } catch {
          this.exitListeners.forEach(fn => fn(0));
        }
        this.eventSource?.close();
      });

      this.eventSource.onerror = () => {
        // stream closed or error
      };
    }
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      this.dataListeners = this.dataListeners.filter(fn => fn !== cb);
    };
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.push(cb);
    return () => {
      this.exitListeners = this.exitListeners.filter(fn => fn !== cb);
    };
  }

  async write(data: string): Promise<void> {
    if (!this.currentId) return;

    if (this.isTauri) {
      await invoke('write_pty', { id: this.currentId, data });
    } else {
      await fetch('/api/pty/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.currentId, data }),
      });
    }
  }

  async kill(signal: string = 'SIGINT'): Promise<void> {
    if (!this.currentId) return;

    if (this.isTauri) {
      await invoke('kill_pty', { id: this.currentId });
    } else {
      await fetch('/api/pty/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.currentId, signal }),
      });
    }
  }

  destroy(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.unlistenData) {
      this.unlistenData();
      this.unlistenData = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
    this.dataListeners = [];
    this.exitListeners = [];
  }
}

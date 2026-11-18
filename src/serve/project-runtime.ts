// Running chats and their project's settings (task #11 step 6). Each chat starts with its project's folders and variables (src/core/
// projects.ts, passed by ChatLaunch); this remembers what each running chat got, tells which ones are stale after a change, and brings
// a change to them: a new folder live through the CLI's own way (chorus-core src/livedir.ts, decision 13), everything else by a restart
// (resume, conversation kept) once the chat's turn has ended. A chat in the middle of a turn is never restarted or typed into.
import crypto from 'node:crypto';
import path from 'node:path';
import { liveAddDirWay } from '@chauvoluuhuong/chorus-core';
import type { ProjectSettings } from '../core/projects.ts';
import type { AgentId } from '../core/types.ts';

export type LiveWay = 'slash' | 'grant' | 'none';

export type ProjectChange =
  | { kind: 'add_folder'; path: string }
  | { kind: 'remove_folder'; path: string }
  | { kind: 'set_variable'; name: string }
  | { kind: 'remove_variable'; name: string }
  | { kind: 'note' };

export interface RuntimeDeps {
  settings: ProjectSettings;
  /** ids of the chats whose CLI runs now */
  running(): string[];
  /** a chat's CLI, project folder and skip mode */
  chat(id: string): { agent: AgentId; project: string; skip: boolean } | undefined;
  /** #10's watcher: idle (its turn ended) with nothing waited on */
  idle(id: string): boolean;
  /** the user has text in the chat's input or typed in it just now */
  typing(id: string): boolean;
  /** stops the chat's process and resumes it (conversation kept); it then launches with the project's current settings */
  restart(id: string): void;
  /** the CLI's own live add of one folder (types `/add-dir`, or Codex's grant through its transport); true once the CLI confirmed it */
  liveAdd(id: string, agent: AgentId, dir: string, way: LiveWay): Promise<boolean>;
  /** calls fn once, when the chat is idle and its turn has ended (at once if it is idle now); `again` waits a few seconds more */
  onTurnEnd(id: string, fn: () => void, again?: boolean): void;
  /** how a CLI gets a folder live (tests: a fake); chorus-core's liveAddDirWay otherwise */
  way?(agent: AgentId, skip: boolean): LiveWay | undefined;
}

interface Launched {
  project: string;
  version: number;
  folders: string[];
  variables: string[];
  /** a hash of the values, in memory only: tells a changed value apart; never the values themselves */
  sig: string;
}

const sigOf = (env: Record<string, string>) => crypto.createHash('sha256').update(JSON.stringify(Object.keys(env).sort().map(k => [k, env[k]]))).digest('hex');
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

export class ProjectRuntime {
  private d: RuntimeDeps;
  private launchedWith = new Map<string, Launched>();
  /** chats that restart once their turn ends */
  private atTurnEnd = new Set<string>();
  /** a live add running per chat */
  private adding = new Set<string>();

  constructor(d: RuntimeDeps) {
    this.d = d;
  }

  /** Where the launcher runs (ChatLaunch.extras): what this start or resume of the chat gets. */
  launched(threadId: string, project: string, addDirs: string[], env: Record<string, string>) {
    const p = path.resolve(project);
    this.launchedWith.set(threadId, { project: p, version: this.d.settings.get(p).version, folders: [...addDirs], variables: Object.keys(env), sig: sigOf(env) });
    this.atTurnEnd.delete(threadId);
  }

  /** The chat's process ended. */
  exited(threadId: string) {
    this.launchedWith.delete(threadId);
  }

  /** What the running chat has: its folders (with those added live) and its variable names; undefined when it is not running. */
  chatHas(threadId: string): { folders: string[]; variables: string[]; version: number } | undefined {
    const l = this.launchedWith.get(threadId);
    return l && this.d.running().includes(threadId) ? { folders: [...l.folders], variables: [...l.variables], version: l.version } : undefined;
  }

  private isStale(id: string, project: string): boolean {
    const l = this.launchedWith.get(id);
    if (!l) return false;
    const s = this.d.settings;
    const env = s.env(project);
    return !sameSet(l.folders, s.addDirs(project)) || !sameSet(l.variables, Object.keys(env)) || l.sig !== sigOf(env);
  }

  /** Running chats of the project missing something it has now, or having something it no longer has. */
  staleChats(folder: string): string[] {
    const p = path.resolve(folder);
    return this.d.running().filter(id => this.launchedWith.get(id)?.project === p && this.isStale(id, p));
  }

  /** "Restart idle ones": idle stale chats restart now; a chat in the middle of a turn restarts when it finishes. */
  restartIdle(folder: string): { restarted: string[]; waiting: string[] } {
    const restarted: string[] = [], waiting: string[] = [];
    for (const id of this.staleChats(folder)) {
      if (this.d.idle(id) && !this.d.typing(id)) {
        this.atTurnEnd.delete(id);
        this.d.restart(id);
        restarted.push(id);
      } else {
        this.restartAtTurnEnd(id);
        waiting.push(id);
      }
    }
    return { restarted, waiting };
  }

  /**
   * Restarts the chat once its current turn has ended and the user is not typing in it (reload_project_settings, step 8). `settle`:
   * the chat is about to get a message (an approved proposal's answer), so a turn end counts only after a few seconds of idle.
   */
  restartAtTurnEnd(threadId: string, o: { settle?: boolean } = {}) {
    if (this.atTurnEnd.has(threadId)) return;
    this.atTurnEnd.add(threadId);
    const go = () => {
      if (!this.atTurnEnd.has(threadId) || !this.d.running().includes(threadId)) return void this.atTurnEnd.delete(threadId);
      if (!this.d.idle(threadId) || this.d.typing(threadId)) return this.d.onTurnEnd(threadId, go, true);
      this.atTurnEnd.delete(threadId);
      this.d.restart(threadId);
    };
    this.d.onTurnEnd(threadId, go, o.settle);
  }

  /** Whether a restart is queued for the chat. */
  restartPending(threadId: string) {
    return this.atTurnEnd.has(threadId);
  }

  /**
   * Brings one change of the project to its running chats. A new folder goes live through the CLI's own way when it has one (only
   * while the chat is idle, its input empty and the user not typing: otherwise at its turn end); without one, or when the live add
   * fails, the chat restarts at its turn end. A removed folder and every variable change restart the chats at their turn end
   * (`restart: false` only marks them stale: the page's banner then offers "Restart idle ones"). A note needs nothing.
   */
  async applyToRunning(folder: string, change: ProjectChange, o: { restart?: boolean } = {}): Promise<Record<string, 'live' | 'has' | 'restart' | 'stale' | 'later'>> {
    const p = path.resolve(folder);
    const out: Record<string, 'live' | 'has' | 'restart' | 'stale' | 'later'> = {};
    if (change.kind === 'note') return out;
    const chats = this.d.running().filter(id => this.launchedWith.get(id)?.project === p);
    if (change.kind !== 'add_folder') {
      for (const id of chats) {
        if (!this.isStale(id, p)) continue;
        if (o.restart === false) out[id] = 'stale';
        else {
          this.restartAtTurnEnd(id);
          out[id] = 'restart';
        }
      }
      return out;
    }
    const dir = path.resolve(change.path);
    await Promise.all(chats.map(async id => {
      const l = this.launchedWith.get(id)!;
      if (l.folders.includes(dir)) return void (out[id] = 'has');
      const c = this.d.chat(id);
      const way = c ? (this.d.way ?? ((a, skip) => liveAddDirWay(a, { skipPermissions: skip })))(c.agent, c.skip) : undefined;
      if (!c || !way) {
        if (o.restart === false) out[id] = 'stale';
        else {
          this.restartAtTurnEnd(id);
          out[id] = 'restart';
        }
        return;
      }
      if (way === 'none') {
        l.folders.push(dir);
        return void (out[id] = 'has');
      }
      if (this.d.idle(id) && !this.d.typing(id) && !this.adding.has(id)) out[id] = (await this.addLive(id, c.agent, dir, way, o)) ? 'live' : 'restart';
      else {
        out[id] = 'later';
        const go = () => {
          if (!this.d.running().includes(id) || this.launchedWith.get(id)?.folders.includes(dir)) return;
          if (!this.d.idle(id) || this.d.typing(id) || this.adding.has(id)) return this.d.onTurnEnd(id, go, true);
          void this.addLive(id, c.agent, dir, way, o);
        };
        this.d.onTurnEnd(id, go);
      }
    }));
    return out;
  }

  private async addLive(id: string, agent: AgentId, dir: string, way: LiveWay, o: { restart?: boolean }): Promise<boolean> {
    this.adding.add(id);
    let ok = false;
    try {
      ok = await this.d.liveAdd(id, agent, dir, way);
    } catch {
      ok = false;
    } finally {
      this.adding.delete(id);
    }
    const l = this.launchedWith.get(id);
    if (ok && l && !l.folders.includes(dir)) l.folders.push(dir);
    if (!ok && o.restart !== false) this.restartAtTurnEnd(id);
    return ok;
  }
}

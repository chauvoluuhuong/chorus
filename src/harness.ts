import type {
  ChorusAppState,
  Thread,
  ApprovalRequest,
  SkillBundle,
  PromptEnvelope,
  AgentId,
  ArtifactItem,
} from './types';
import type { PtyClient, PtySpawnOptions } from './services/pty';

export interface ChorusTestHarness {
  getState(): ChorusAppState;
  getActiveThread(): Thread | null;
  getPendingApprovals(): ApprovalRequest[];
  getArtifactPanelWidth(): number;
  isArtifactPanelVisible(): boolean;
  getActiveSkills(): SkillBundle[];

  // Component Action Dispatchers
  setAutonomousMode(enabled: boolean): void;
  setArtifactPanelWidth(widthPx: number): void;
  resetArtifactPanelWidth(): void;
  selectAgentModel(agentId: AgentId, modelId: string): void;
  triggerMidSessionHandoff(targetAgentId: AgentId): Promise<void>;
  simulateFileDrop(files: { name: string; content: string }[]): Promise<void>;

  setArtifactPanelVisible(visible: boolean): void;
  setActiveArtifact(artifact: ArtifactItem | null): void;
  setActiveArtifactVersion(version: number): void;
  setPendingApprovals(approvals: ApprovalRequest[]): void;
  setSkills(skills: SkillBundle[]): void;

  // Observability & Synchronization
  waitForState<T>(
    selector: (state: ChorusAppState) => T,
    predicate: (val: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  waitForEvent(
    event: 'pty:data' | 'artifact:updated' | 'approval:requested' | 'handoff:completed' | 'pty:exit',
    timeoutMs?: number,
  ): Promise<any>;
  on(event: string, callback: (...args: any[]) => void): () => void;
  emit(event: string, ...args: any[]): void;

  // DB & Subsystem Inspection
  getDatabaseRecords(
    table: 'threads' | 'turns' | 'executions' | 'artifacts' | 'skills' | 'memory' | 'activity',
  ): Promise<any[]>;
  getSharedMemory(): any;
  getActivityEvents(): any[];
  setMemoryState?(memory: any): void;
  addActivityEvent?(event: any): void;
  getLastPromptEnvelope(): PromptEnvelope | null;
  setLastPromptEnvelope(envelope: PromptEnvelope): void;

  // Direct PTY trigger helper for tests
  spawnTestPty(options?: Partial<PtySpawnOptions>): Promise<void>;
  writePty(input: string): Promise<void>;
  killPty(signal?: string): Promise<void>;
}

declare global {
  interface Window {
    __CHORUS_HARNESS__?: ChorusTestHarness;
  }
}

export function createHarness(
  getStateRef: () => ChorusAppState,
  actions: {
    setAutonomousMode: (enabled: boolean) => void;
    setArtifactPanelWidth: (width: number) => void;
    resetArtifactPanelWidth: () => void;
    setArtifactPanelVisible: (visible: boolean) => void;
    setActiveArtifact: (artifact: ArtifactItem | null) => void;
    setActiveArtifactVersion: (version: number) => void;
    setPendingApprovals: (approvals: ApprovalRequest[]) => void;
    setSkills: (skills: SkillBundle[]) => void;
    selectAgentModel: (agentId: AgentId, modelId: string) => void;
    triggerMidSessionHandoff: (targetAgentId: AgentId) => Promise<void>;
    simulateFileDrop: (files: { name: string; content: string }[]) => Promise<void>;
    getPtyClient: () => PtyClient | null;
    spawnPty: (options: PtySpawnOptions) => Promise<void>;
    setPromptEnvelope: (envelope: PromptEnvelope) => void;
    setMemoryState?: (memory: any) => void;
    addActivityEvent?: (event: any) => void;
  },
): ChorusTestHarness {
  const eventListeners = new Map<string, ((...args: any[]) => void)[]>();

  const harness: ChorusTestHarness = {
    getState: () => getStateRef(),
    getActiveThread: () => {
      const state = getStateRef();
      return state.threads.find(t => t.id === state.activeThreadId) || null;
    },
    getPendingApprovals: () => getStateRef().pendingApprovals,
    getArtifactPanelWidth: () => getStateRef().artifactPanelWidth,
    isArtifactPanelVisible: () => getStateRef().artifactPanelVisible,
    getActiveSkills: () => getStateRef().skills.filter(s => s.active),

    setAutonomousMode: actions.setAutonomousMode,
    setArtifactPanelWidth: actions.setArtifactPanelWidth,
    resetArtifactPanelWidth: actions.resetArtifactPanelWidth,
    setArtifactPanelVisible: actions.setArtifactPanelVisible,
    setActiveArtifact: actions.setActiveArtifact,
    setActiveArtifactVersion: actions.setActiveArtifactVersion,
    setPendingApprovals: actions.setPendingApprovals,
    setSkills: actions.setSkills,
    selectAgentModel: actions.selectAgentModel,
    triggerMidSessionHandoff: actions.triggerMidSessionHandoff,
    simulateFileDrop: actions.simulateFileDrop,
    setMemoryState: actions.setMemoryState,
    addActivityEvent: actions.addActivityEvent,

    on: (event: string, callback: (...args: any[]) => void) => {
      const list = eventListeners.get(event) || [];
      list.push(callback);
      eventListeners.set(event, list);
      return () => {
        const updated = (eventListeners.get(event) || []).filter(cb => cb !== callback);
        eventListeners.set(event, updated);
      };
    },

    emit: (event: string, ...args: any[]) => {
      const list = eventListeners.get(event) || [];
      list.forEach(cb => cb(...args));
    },

    waitForState: <T>(
      selector: (state: ChorusAppState) => T,
      predicate: (val: T) => boolean,
      timeoutMs: number = 10000,
    ): Promise<T> => {
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const check = () => {
          const val = selector(getStateRef());
          if (predicate(val)) {
            resolve(val);
            return;
          }
          if (Date.now() - startTime > timeoutMs) {
            reject(new Error(`Timed out waiting for state condition after ${timeoutMs}ms`));
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
    },

    waitForEvent: (event: string, timeoutMs: number = 10000): Promise<any> => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`));
        }, timeoutMs);

        const unsub = harness.on(event, (...args: any[]) => {
          clearTimeout(timer);
          unsub();
          resolve(args.length === 1 ? args[0] : args);
        });
      });
    },

    getDatabaseRecords: async (table: string) => {
      const state = getStateRef();
      if (table === 'threads') return state.threads;
      if (table === 'skills') return state.skills;
      if (table === 'artifacts') return state.activeArtifact ? [state.activeArtifact] : [];
      if (table === 'memory') return state.memoryState?.workingMemory || [];
      if (table === 'activity') return state.activityEvents || [];
      return [];
    },

    getSharedMemory: () => getStateRef().memoryState,
    getActivityEvents: () => getStateRef().activityEvents || [],

    getLastPromptEnvelope: () => getStateRef().lastPromptEnvelope,
    setLastPromptEnvelope: (envelope: PromptEnvelope) => actions.setPromptEnvelope(envelope),

    spawnTestPty: async (opts?: Partial<PtySpawnOptions>) => {
      const defaultStub = 'tests/e2e/stubs/cli-stub.js';
      const options: PtySpawnOptions = {
        id: opts?.id || 'test-session',
        command: opts?.command || 'node',
        args: opts?.args || [defaultStub],
        cwd: opts?.cwd || undefined,
        env: opts?.env || {},
      };
      await actions.spawnPty(options);
    },

    writePty: async (input: string) => {
      const client = actions.getPtyClient();
      if (client) {
        await client.write(input);
      }
    },

    killPty: async (signal: string = 'SIGINT') => {
      const client = actions.getPtyClient();
      if (client) {
        await client.kill(signal);
      }
    },
  };

  return harness;
}

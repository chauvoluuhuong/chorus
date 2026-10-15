import { useState, useEffect, useRef, type FormEvent } from 'react';
import type {
  ChorusAppState,
  Thread,
  ChatMessage,
  ApprovalRequest,
  SkillBundle,
  ArtifactItem,
  PromptEnvelope,
  AgentId,
  SharedMemoryState,
  ActivityEvent,
} from './types';
import { PtyClient, type PtySpawnOptions } from './services/pty';
import { createHarness } from './harness';
import { TerminalView } from './components/TerminalView';
import { SkillsStudio } from './components/SkillsStudio';
import { SharedMemoryView } from './components/SharedMemoryView';
import { ActivityLogView } from './components/ActivityLogView';
import { MentionPopover, type MentionItem } from './components/MentionPopover';
import { SlashPopover } from './components/SlashPopover';
import { HandoffPopover } from './components/HandoffPopover';
import { Icon } from './components/Icon';



/* ---------- Agent Registry & Configurations ---------- */
export const AGENTS_CONFIG: Record<
  AgentId,
  {
    name: string;
    l: string;
    cli: string;
    account: string;
    models: [string, string, string][];
    usage: {
      limit: number | null;
      resets?: string;
      quotaStatus?: string;
      chat: string;
      ctx: number;
      ctxOf: string;
    };
  }
> = {
  claude: {
    name: 'Claude Code',
    l: 'C',
    cli: 'claude',
    account: 'Anthropic',
    models: [
      ['sonnet', 'Sonnet 5.5', 'Fast and capable. Default.'],
      ['opus', 'Opus 5.5', 'Most capable. Uses quota faster.'],
      ['haiku', 'Haiku 5.5', 'Quickest for lightweight edits.'],
    ],
    usage: { limit: 72, resets: '6:00 PM', chat: '182k', ctx: 34, ctxOf: '68k / 200k' },
  },
  agy: {
    name: 'Antigravity',
    l: 'A',
    cli: 'agy',
    account: 'Google',
    models: [
      ['pro', 'Gemini Pro', 'Deep multi-file reasoning and planning.'],
      ['flash', 'Gemini Flash', 'Ultra-fast lightweight execution.'],
    ],
    usage: {
      limit: null,
      quotaStatus: 'Standard Quota · Active (RPM OK)',
      chat: '0',
      ctx: 0,
      ctxOf: '0 / 1M',
    },
  },
  codex: {
    name: 'Codex',
    l: 'X',
    cli: 'codex',
    account: 'OpenAI',
    models: [
      ['codex', 'GPT Codex', 'Tuned for coding. Default.'],
      ['codex-mini', 'GPT Codex mini', 'Fast and cost-efficient.'],
    ],
    usage: { limit: 18, resets: 'Oct 21', chat: '0', ctx: 0, ctxOf: '0 / 400k' },
  },
};

const INITIAL_SKILLS: SkillBundle[] = [
  {
    id: 'db-migrate',
    name: 'db-migrate',
    command: '/db-migrate',
    description: 'Runs Prisma/Drizzle migrations safely with schema backup',
    path: '.agents/skills/db-migrate/SKILL.md',
    active: true,
    origin: 'Bundled',
    content: '# DB Migrate Skill\nSafely migrate database schemas.',
  },
  {
    id: 'tailwind-ui',
    name: 'tailwind-ui',
    command: '/tailwind-ui',
    description: 'Generates accessible UI components styled with Tailwind CSS',
    path: '.agents/skills/tailwind-ui/SKILL.md',
    active: false,
    origin: 'Bundled',
    content: '# Tailwind UI Skill\nGenerate accessible Tailwind components.',
  },
];

const INITIAL_THREADS: Thread[] = [
  {
    id: 't_cake',
    title: 'Cake order page',
    agent: 'claude',
    model: 'Sonnet 5.5',
    autonomous: false,
    createdAt: '10 mins ago',
    updatedAt: 'Just now',
  },
  {
    id: 't_contact',
    title: 'Fix contact form',
    agent: 'codex',
    model: 'GPT Codex',
    autonomous: false,
    createdAt: '1 hour ago',
    updatedAt: '1 hour ago',
  },
];

const INITIAL_MEMORY_STATE: SharedMemoryState = {
  workingMemory: [
    {
      key: 'active_goal',
      value: 'Order form responsive layout and Prisma migrations with automated rollback safeguards',
      updatedBy: 'claude',
      updatedAt: '2 mins ago',
      readBy: ['claude', 'codex'],
    },
    {
      key: 'touched_files',
      value: '["src/components/OrderForm.tsx", "src-tauri/src/lib.rs", "prisma/schema.prisma"]',
      updatedBy: 'codex',
      updatedAt: '1 min ago',
      readBy: ['claude', 'agy', 'codex'],
    },
    {
      key: 'active_diff',
      value: '+ export function validateOrderForm(data: OrderInput): ValidationResult { ... }',
      updatedBy: 'claude',
      updatedAt: 'Just now',
      readBy: ['claude'],
    },
  ],
  projectDocs: [
    {
      id: 'doc-arch',
      title: 'Chorus Desktop Multi-Engine Architecture',
      path: '.chorus/memory/ARCHITECTURE.md',
      tokens: 1840,
      lastModified: 'Today, 14:20',
      excerpt:
        'Orchestrates Claude Code, Antigravity, and Codex CLI over portable PTY master/slave IPC with zero-overhead SQLite ring buffer.',
    },
    {
      id: 'doc-decisions',
      title: 'Architectural Decision Records (ADRs)',
      path: '.chorus/memory/DECISIONS.md',
      tokens: 920,
      lastModified: 'Yesterday',
      excerpt:
        'ADR-001: Adopt ANSI pseudo-terminal passthrough over JSON-RPC. ADR-002: In-DB Ring Buffer for zero-overhead telemetry.',
    },
  ],
  budgetUsedTokens: 3850,
  budgetMaxTokens: 8000,
  ringBufferCapacity: 500,
  ringBufferUsed: 142,
};

const INITIAL_ACTIVITY_EVENTS: ActivityEvent[] = [
  {
    id: 'ev-101',
    timestamp: '14:22:05',
    type: 'workspace',
    agent: 'claude',
    summary: 'Workspace indexed: 42 files, 3 skills detected',
    meta: { filesCount: 42, scanRoots: ['.agents/skills', '.claude/skills'] },
    durationMs: 45,
  },
  {
    id: 'ev-102',
    timestamp: '14:22:18',
    type: 'bridge',
    agent: 'claude',
    summary: 'PTY Master spawned session "sess-17290123"',
    meta: { pid: 91402, command: 'node', ptyCols: 120, ptyRows: 34 },
    durationMs: 12,
  },
  {
    id: 'ev-103',
    timestamp: '14:23:40',
    type: 'appr',
    agent: 'claude',
    summary: 'Privileged execution gate requested: npx prisma migrate dev',
    meta: { risk: 'HIGH', userAction: 'allowed', command: 'npx prisma migrate dev' },
    durationMs: 820,
  },
  {
    id: 'ev-104',
    timestamp: '14:24:15',
    type: 'hook',
    agent: 'codex',
    summary: 'Mid-session handoff executed: Claude -> Codex',
    meta: { envelopeSizeTokens: 142, transferredKeys: ['active_goal', 'touched_files'] },
    durationMs: 95,
  },
  {
    id: 'ev-105',
    timestamp: '14:25:01',
    type: 'err',
    agent: 'codex',
    summary: 'Non-fatal exit code 1 intercepted from child process',
    meta: { exitCode: 1, signal: 'SIGINT', recovered: true },
    durationMs: 5,
  },
];

export function App() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('light');
  const [currentView, setCurrentView] = useState<'chat' | 'terminal' | 'skills' | 'memory' | 'activity'>('chat');
  const [screen, setScreen] = useState<'home' | 'thread'>('thread');
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat');

  const [selectedAgent, setSelectedAgent] = useState<AgentId>('claude');
  const [selectedModel, setSelectedModel] = useState<string>('Sonnet 5.5');
  const [modelsState, setModelsState] = useState<Record<AgentId, string>>({
    claude: 'sonnet',
    agy: 'pro',
    codex: 'codex',
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAgent, setMenuAgent] = useState<AgentId>('claude');
  const [handoffMenuOpen, setHandoffMenuOpen] = useState(false);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  const [continueFromThread, setContinueFromThread] = useState<string>('none');
  const [autonomousMode, setAutonomousMode] = useState<boolean>(false);
  const [inlineStatus, setInlineStatus] = useState<'pending' | 'allowed' | 'denied'>('pending');
  const [agentRunning, setAgentRunning] = useState<boolean>(false);

  // Artifact Canvas State
  const [artifact, setArtifact] = useState<string | null>(null);
  const [artifactVersion, setArtifactVersion] = useState<number>(2);
  const [artifactTab, setArtifactTab] = useState<'preview' | 'code' | 'diff'>('preview');
  const [artifactPanelWidth, setArtifactPanelWidth] = useState<number>(580);
  const [isArtFullscreen, setIsArtFullscreen] = useState<boolean>(false);
  const [activeArtifactItem, setActiveArtifactItem] = useState<ArtifactItem | null>(null);

  const [toolsOpen, setToolsOpen] = useState<boolean>(true);
  const [limited, setLimited] = useState<boolean>(false);
  const [handedTo, setHandedTo] = useState<AgentId | null>(null);

  const [promptInput, setPromptInput] = useState<string>('');
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const [threads, setThreads] = useState<Thread[]>(INITIAL_THREADS);
  const [activeThreadId, setActiveThreadId] = useState<string>('t_cake');
  const [ptyStatus, setPtyStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'terminated'>('disconnected');
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([
    {
      id: 'appr-init-1',
      threadId: 't_cake',
      toolCallId: 'tool-init-1',
      command: 'npx prisma migrate dev --name add_orders',
      summary: 'Privileged execution gate requested',
      risk: 'Modifies database schema',
      status: 'pending',
      timestamp: 'Just now',
    },
  ]);
  const [skills, setSkills] = useState<SkillBundle[]>(INITIAL_SKILLS);
  const [lastPromptEnvelope, setLastPromptEnvelope] = useState<PromptEnvelope | null>(null);
  const [memoryState, setMemoryState] = useState<SharedMemoryState>(INITIAL_MEMORY_STATE);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>(INITIAL_ACTIVITY_EVENTS);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const ptyClientRef = useRef<PtyClient | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const isResizingRef = useRef<boolean>(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(580);

  const stateRef = useRef<ChorusAppState>({
    threads,
    activeThreadId,
    currentView: (currentView === 'chat' && mode === 'terminal' ? 'terminal' : currentView) as any,
    ptyStatus,
    autonomousMode,
    artifactPanelVisible: Boolean(artifact || activeArtifactItem),
    artifactPanelWidth,
    activeArtifact: activeArtifactItem,
    activeArtifactVersion: artifactVersion,
    pendingApprovals,
    skills,
    selectedAgent,
    selectedModel,
    lastPromptEnvelope,
    memoryState,
    activityEvents,
  });

  // Apply theme to document root
  useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Keep stateRef fresh for test harness
  useEffect(() => {
    stateRef.current = {
      threads,
      activeThreadId,
      currentView: (currentView === 'chat' && mode === 'terminal' ? 'terminal' : currentView) as any,
      ptyStatus,
      autonomousMode,
      artifactPanelVisible: Boolean(artifact || activeArtifactItem),
      artifactPanelWidth,
      activeArtifact: activeArtifactItem,
      activeArtifactVersion: artifactVersion,
      pendingApprovals,
      skills,
      selectedAgent,
      selectedModel,
      lastPromptEnvelope,
      memoryState,
      activityEvents,
    };
  }, [
    threads,
    activeThreadId,
    currentView,
    mode,
    ptyStatus,
    autonomousMode,
    artifact,
    activeArtifactItem,
    artifactPanelWidth,
    artifactVersion,
    pendingApprovals,
    skills,
    selectedAgent,
    selectedModel,
    lastPromptEnvelope,
    memoryState,
    activityEvents,
  ]);

  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 3000);
  };

  /* ---------- PTY Execution Spawner ---------- */
  const spawnPtySession = async (options: PtySpawnOptions) => {
    if (ptyClientRef.current) {
      ptyClientRef.current.destroy();
    }
    const client = new PtyClient();
    ptyClientRef.current = client;
    setPtyStatus('connecting');
    if (!options.env?.CHORUS_TARGET_ENGINE) {
      setMode('terminal');
    }

    client.onData(data => {
      window.__CHORUS_HARNESS__?.emit('pty:data', data);

      const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      if (clean && !clean.includes('Authorize command:') && !clean.includes('[y/n]:')) {
        setMessages(prev => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role === 'assistant') {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content ? `${last.content}${clean}` : clean },
            ];
          }
          return prev;
        });
      }

      const approvalMatch = data.match(/Authorize command:\s*(.*?)\s*\[y\/n\]:/i);
      if (approvalMatch) {
        const cmd = approvalMatch[1].trim();
        const req: ApprovalRequest = {
          id: `appr-${Date.now()}`,
          threadId: activeThreadId,
          toolCallId: `tool-${Date.now()}`,
          command: cmd,
          summary: `Privileged command execution: ${cmd}`,
          risk: 'Modifies database schemas / executes system commands',
          status: 'pending',
          timestamp: 'Just now',
        };
        setPendingApprovals([req]);
        setInlineStatus('pending');
        setScreen('thread');
        setMode('chat');
        window.__CHORUS_HARNESS__?.emit('approval:requested', req);
      }

      if (data.includes('auto-approved --dangerously-skip-permissions')) {
        setAutonomousMode(true);
        setInlineStatus('allowed');
        setScreen('thread');
        setMode('chat');
      }
    });

    client.onExit(code => {
      setPtyStatus('terminated');
      stateRef.current = { ...stateRef.current, ptyStatus: 'terminated' };
      setAgentRunning(false);
      window.__CHORUS_HARNESS__?.emit('pty:exit', code);
    });

    try {
      await client.spawn(options);
      setPtyStatus('connected');
      stateRef.current = { ...stateRef.current, ptyStatus: 'connected' };
      setAgentRunning(true);
    } catch (err) {
      setPtyStatus('terminated');
      stateRef.current = { ...stateRef.current, ptyStatus: 'terminated' };
      setAgentRunning(false);
      console.error('PTY spawn failed:', err);
    }
  };

  /* ---------- Draggable Resizer Listeners ---------- */
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current || isArtFullscreen) return;
      const delta = startXRef.current - e.clientX;
      const minW = 320;
      const maxW = Math.max(380, Math.round(window.innerWidth * 0.85));
      const newWidth = Math.min(Math.max(minW, Math.round(startWidthRef.current + delta)), maxW);
      setArtifactPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        document.querySelector('.app')?.classList.remove('art-resizing');
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isArtFullscreen]);

  /* ---------- Live OS Artifact Watcher ---------- */
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/artifacts/stream');
      es.addEventListener('artifact:updated', (e: MessageEvent) => {
        try {
          const art = JSON.parse(e.data);
          const item: ArtifactItem = {
            id: `art-${Date.now()}`,
            threadId: art.threadId || activeThreadId,
            agent: art.agent || selectedAgent,
            path: art.path,
            name: art.name,
            version: art.version || 1,
            content: art.content,
            createdAt: 'Just now',
          };
          setActiveArtifactItem(item);
          setArtifact(item.id);
          window.__CHORUS_HARNESS__?.emit('artifact:updated', item);
        } catch {}
      });
    } catch {}
    return () => es?.close();
  }, [activeThreadId, selectedAgent]);

  /* ---------- Harness Setup ---------- */
  useEffect(() => {
    const harness = createHarness(
      () => stateRef.current,
      {
        setAutonomousMode: enabled => setAutonomousMode(enabled),
        setArtifactPanelWidth: w => {
          setArtifactPanelWidth(w);
          stateRef.current = { ...stateRef.current, artifactPanelWidth: w };
        },
        resetArtifactPanelWidth: () => {
          setArtifactPanelWidth(580);
          stateRef.current = { ...stateRef.current, artifactPanelWidth: 580 };
        },
        setArtifactPanelVisible: v => {
          if (!v) {
            setArtifact(null);
            setActiveArtifactItem(null);
          } else if (!artifact) {
            setArtifact('order');
          }
        },
        setActiveArtifact: a => {
          setActiveArtifactItem(a);
          if (a) setArtifact(a.id);
        },
        setActiveArtifactVersion: v => setArtifactVersion(v),
        setPendingApprovals: apps => setPendingApprovals(apps),
        setSkills: sks => setSkills(sks),
        selectAgentModel: (agent, model) => {
          setSelectedAgent(agent);
          setSelectedModel(model);
        },
        triggerMidSessionHandoff: (targetAgent: AgentId) => handleTriggerHandoff(targetAgent),
        simulateFileDrop: async () => {},
        getPtyClient: () => ptyClientRef.current,
        spawnPty: spawnPtySession,
        setPromptEnvelope: envelope => setLastPromptEnvelope(envelope),
        setMemoryState: mem => setMemoryState(mem),
        addActivityEvent: ev => setActivityEvents(prev => [ev, ...prev]),
      },
    );

    window.__CHORUS_HARNESS__ = harness;

    // Check query params for test auto-boot
    const params = new URLSearchParams(window.location.search);
    if (params.get('auto_spawn') === '1') {
      const scenarioFile = params.get('scenario') || undefined;
      spawnPtySession({
        id: 'auto-test-session',
        command: 'node',
        args: ['tests/e2e/stubs/cli-stub.js'],
        env: scenarioFile ? { CHORUS_SCENARIO_FILE: scenarioFile } : {},
      });
    }

    return () => {
      ptyClientRef.current?.destroy();
    };
  }, []);

  /* ---------- Handlers ---------- */
  const handleTriggerHandoff = async (targetAgent: AgentId) => {
    const targetModel =
      targetAgent === 'codex' ? 'GPT Codex' : targetAgent === 'agy' ? 'Gemini Pro' : 'Sonnet 5.5';
    const targetName =
      targetAgent === 'codex' ? 'Codex' : targetAgent === 'agy' ? 'Antigravity' : 'Claude Code';

    const envelope: PromptEnvelope = {
      turn_id: `turn-handoff-${Date.now()}`,
      target_engine: targetAgent,
      user_prompt: `[HANDOFF FROM ${selectedAgent.toUpperCase()}]: Continued goal 'Order form responsive layout and Prisma migrations'. Touched files: ['src/components/OrderForm.tsx']. Recent task: Complete tests and verify UI layout.`,
      context_files: ['src/components/OrderForm.tsx'],
      context_artifacts: artifact ? ['.chorus/artifacts/claude/t_order_cake/order-flow.html'] : [],
      on_demand_skills: ['tailwind-ui'],
      shared_memory_budget_tokens: 4000,
    };

    setSelectedAgent(targetAgent);
    setSelectedModel(targetModel);
    setHandedTo(targetAgent);
    setLimited(false);
    setHandoffMenuOpen(false);
    setLastPromptEnvelope(envelope);
    setScreen('thread');
    setCurrentView('chat');
    setMode('chat');

    if (ptyClientRef.current) {
      await ptyClientRef.current.kill('SIGINT');
    }

    await spawnPtySession({
      id: `handoff-${targetAgent}-${Date.now()}`,
      command: 'node',
      args: ['tests/e2e/stubs/cli-stub.js', '--agent', targetAgent],
      env: {
        CHORUS_TARGET_ENGINE: targetAgent,
        CHORUS_PROMPT_ENVELOPE: JSON.stringify(envelope),
      },
    });

    showToast(`Handed off to ${targetName} via Prompt Envelope & MCP`);
    window.__CHORUS_HARNESS__?.emit('handoff:completed', { targetAgent, envelope });
  };

  const handleAllowApproval = async () => {
    if (ptyClientRef.current) {
      await ptyClientRef.current.write('y\n');
    }
    setInlineStatus('allowed');
    setPendingApprovals([]);
    showToast('Allowed (y). Migration is running...');
  };

  const handleDenyApproval = async () => {
    if (ptyClientRef.current) {
      await ptyClientRef.current.write('n\n');
    }
    setInlineStatus('denied');
    setPendingApprovals([]);
    showToast("Don't allow (n). Claude stopped.");
  };

  const handleSyncSkills = async () => {
    showToast('Scanning .agents/skills, .claude/skills, and .codex/skills...');
    try {
      const res = await fetch('/api/skills/scan', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const found: SkillBundle[] = data.skills || [];
        setSkills(prev => {
          const map = new Map(prev.map(s => [s.id, s]));
          for (const item of found) {
            map.set(item.id, { ...item });
          }
          const updated = Array.from(map.values());
          stateRef.current = { ...stateRef.current, skills: updated };
          return updated;
        });
        const msg = `Scanned ${data.scannedCount} skill folders · ${data.newCount} new skill${data.newCount === 1 ? '' : 's'} imported`;
        showToast(msg);
        window.__CHORUS_HARNESS__?.emit('skills:scanned', data);
      }
    } catch {}
  };

  const handleToggleSkill = async (skillId: string, active: boolean) => {
    const currentSkill = stateRef.current.skills.find(s => s.id === skillId);
    const content =
      currentSkill?.content ||
      `# ${skillId} Skill\nGenerate accessible UI components styled with Tailwind CSS.`;

    const updated = stateRef.current.skills.map(s => {
      if (s.id === skillId) return { ...s, active };
      return s;
    });
    setSkills(updated);
    stateRef.current = { ...stateRef.current, skills: updated };

    try {
      await fetch('/api/skills/materialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: skillId, active, content }),
      });
      window.__CHORUS_HARNESS__?.emit('skill:toggled', { id: skillId, active });
    } catch {}
  };

  const handleComposerSubmit = (e?: FormEvent) => {
    if (e) e.preventDefault();
    const val = promptInput.trim();
    if (!val) return;

    if (screen === 'home') {
      setScreen('thread');
      setCurrentView('chat');
    }

    // Assemble PromptEnvelope for Harness & IPC
    const envelope: PromptEnvelope = {
      turn_id: `turn-${Date.now()}`,
      target_engine: selectedAgent,
      user_prompt: val,
      context_files: val.includes('@src/components/OrderForm.tsx') ? ['src/components/OrderForm.tsx'] : [],
      context_artifacts: val.includes('@order-flow.html') ? ['.chorus/artifacts/claude/t_order_cake/order-flow.html'] : [],
      on_demand_skills: val.includes('/tailwind-ui') ? ['# Tailwind UI Skill\nGenerate accessible Tailwind components.'] : [],
      shared_memory_budget_tokens: 4000,
    };

    setLastPromptEnvelope(envelope);
    stateRef.current = { ...stateRef.current, lastPromptEnvelope: envelope };

    const newMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      threadId: activeThreadId,
      role: 'user',
      content: val,
      timestamp: 'Just now',
    };
    setMessages(prev => [...prev, newMsg]);
    setPromptInput('');

    if (ptyStatus === 'connected' && ptyClientRef.current) {
      ptyClientRef.current.write(val + '\n');
    } else {
      const asstMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        threadId: activeThreadId,
        role: 'assistant',
        agent: selectedAgent,
        model: selectedModel,
        content: '',
        timestamp: 'Just now',
      };
      setMessages(prev => [...prev, asstMsg]);

      spawnPtySession({
        id: `sess-${selectedAgent}-${Date.now()}`,
        command: 'node',
        args: [
          'tests/e2e/stubs/cli-stub.js',
          '--agent',
          selectedAgent,
          ...(autonomousMode ? ['--dangerously-skip-permissions'] : []),
        ],
        env: {
          CHORUS_TARGET_ENGINE: selectedAgent,
          CHORUS_PROMPT: val,
          ...(autonomousMode ? { CHORUS_AUTONOMOUS: '1' } : {}),
        },
      });
    }
  };

  const handleNewChat = () => {
    const newId = `thread-${Date.now()}`;
    const newThread: Thread = {
      id: newId,
      title: 'New Chat',
      agent: selectedAgent,
      model: selectedModel,
      autonomous: autonomousMode,
      createdAt: 'Just now',
      updatedAt: 'Just now',
    };
    setThreads(prev => [newThread, ...prev]);
    setActiveThreadId(newId);
    setCurrentView('chat');
    setScreen('home');
    setArtifact(null);
  };

  const artifactPanelVisible = Boolean(artifact || activeArtifactItem);

  return (
    <>
      {/* App Window Frame */}
      <section className="window" id="window" aria-label="Chorus app window" data-theme={theme}>
        <div
          className={`app ${artifactPanelVisible ? '' : 'art-collapsed'} ${
            isArtFullscreen ? 'art-full' : ''
          }`}
        >
          {/* Sidebar */}
          <aside className="sidebar">
            <div className="sb-head">
              <span className="wordmark">
                <span className="glyph" aria-hidden="true">
                  <b />
                  <b />
                  <b />
                </span>
                Chorus
              </span>
              <button
                className="ghost-icon"
                type="button"
                aria-label="Toggle sidebar"
                onClick={() => showToast('Collapses sidebar')}
              >
                <Icon name="side" />
              </button>
            </div>

            <button
              className="nav new"
              type="button"
              data-test="new-chat-btn"
              onClick={handleNewChat}
            >
              <span className="plus">
                <Icon name="plus" />
              </span>
              <span>New chat</span>
            </button>

            <button
              className={`nav ${currentView === 'chat' && screen === 'thread' && mode === 'chat' ? 'on' : ''}`}
              type="button"
              data-test="nav-chat"
              onClick={() => {
                setCurrentView('chat');
                setScreen('thread');
                setMode('chat');
              }}
            >
              <Icon name="chats" />
              <span>Chats</span>
            </button>

            <button
              className={`nav ${currentView === 'skills' ? 'on' : ''}`}
              type="button"
              data-test="nav-skills"
              onClick={() => setCurrentView('skills')}
            >
              <Icon name="skills" />
              <span>Skills</span>
            </button>

            <button
              className={`nav ${currentView === 'memory' ? 'on' : ''}`}
              type="button"
              data-test="nav-memory"
              onClick={() => setCurrentView('memory')}
            >
              <Icon name="memory" />
              <span>Shared memory</span>
            </button>

            <button
              className={`nav ${currentView === 'activity' ? 'on' : ''}`}
              type="button"
              data-test="nav-activity"
              onClick={() => setCurrentView('activity')}
            >
              <Icon name="activity" />
              <span>Activity log</span>
            </button>



            <div className="sb-label">Recent chats</div>
            <div className="recents">
              {threads.map(t => (
                <button
                  key={t.id}
                  type="button"
                  className={`recent ${
                    t.id === activeThreadId && currentView === 'chat' && screen === 'thread'
                      ? 'on'
                      : ''
                  }`}
                  onClick={() => {
                    setActiveThreadId(t.id);
                    setCurrentView('chat');
                    setScreen('thread');
                    setMode('chat');
                  }}
                  data-test={`thread-item-${t.id}`}
                >
                  <span>{t.title}</span>
                  <span className={`mark xs m-${t.agent}`}>{t.agent[0].toUpperCase()}</span>
                </button>
              ))}
            </div>

            <div className="sb-foot">
              <button
                className="nav"
                style={{ width: 'auto', flex: 1 }}
                type="button"
                onClick={() => showToast('Settings & CLI config')}
              >
                <Icon name="gear" />
                <span>Settings</span>
              </button>
              <div className="theme-pill" title="Theme Mode">
                <button
                  className={theme === 'system' ? 'on' : ''}
                  type="button"
                  title="System Auto"
                  onClick={() => setTheme('system')}
                >
                  <Icon name="monitor" className="sm" />
                </button>
                <button
                  className={theme === 'light' ? 'on' : ''}
                  type="button"
                  title="Light"
                  data-test="theme-light-btn"
                  onClick={() => setTheme('light')}
                >
                  <Icon name="sun" className="sm" />
                </button>
                <button
                  className={theme === 'dark' ? 'on' : ''}
                  type="button"
                  title="Dark"
                  data-test="theme-dark-btn"
                  onClick={() => setTheme('dark')}
                >
                  <Icon name="moon" className="sm" />
                </button>
              </div>
            </div>
          </aside>

          {/* Main Workspace Pane */}
          <main className="main">
            {/* Topbar */}
            <header className="topbar">
              <button
                className="title-btn"
                type="button"
                data-test={screen !== 'home' ? 'toggle-skip-permissions' : 'thread-title-btn'}
                onClick={() => setAutonomousMode(!autonomousMode)}
                title="Toggle autonomous permissions bypass"
              >
                <strong>Cake order page</strong>
                <span className="sub">· sweet-crumb</span>
                {autonomousMode && (
                  <span
                    className="chiplet"
                    style={{
                      color: 'var(--warn)',
                      background: 'var(--warn-soft)',
                      border: '1px solid var(--warn)',
                      fontSize: 11,
                      padding: '1px 6px',
                    }}
                  >
                    ⚡ auto-approve
                  </span>
                )}
                <Icon name="chev" className="sm" />
              </button>

              <div className="top-right">
                {currentView === 'chat' && (
                  <div className="seg" role="group" aria-label="View switch">
                    <button
                      type="button"
                      aria-pressed={mode === 'chat'}
                      onClick={() => setMode('chat')}
                    >
                      <Icon name="chats" className="sm" /> Chat
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === 'terminal'}
                      data-test="nav-terminal"
                      onClick={() => setMode('terminal')}
                    >
                      <Icon name="term" className="sm" /> Terminal
                    </button>
                  </div>
                )}

                <button
                  className="bell"
                  type="button"
                  id="bell"
                  data-test="header-bell-btn"
                  aria-label="Background approvals"
                  aria-expanded={bellOpen}
                  onClick={() => setBellOpen(!bellOpen)}
                >
                  <Icon name="bell" />
                  {pendingApprovals.length > 0 && !autonomousMode && (
                    <span className="badge" data-test="header-bell-badge">
                      {pendingApprovals.length}
                    </span>
                  )}
                </button>

                {bellOpen && (
                  <div className="notif" role="dialog" aria-label="Notifications">
                    <div className="notif-head">
                      <strong>Background Approvals</strong>
                      <button
                        className="btn sm btn-plain"
                        type="button"
                        onClick={() => showToast('All marked read')}
                      >
                        Mark read
                      </button>
                    </div>
                    <div className="notif-sec">Other Background Chats</div>
                    <div className="n">
                      <span className="mark m-codex xs">X</span>
                      <div className="n-body">
                        <span className="n-meta">
                          Codex · Fix contact form · 8m ago <span className="risk">Risky</span>
                        </span>
                        <span className="n-title">Delete 214 old build files</span>
                        <div className="code">rm -rf ./dist</div>
                        <div className="btns">
                          <button
                            className="btn sm btn-dark"
                            type="button"
                            onClick={() => showToast('Approved for contact form thread')}
                          >
                            Allow
                          </button>
                          <button
                            className="btn sm"
                            type="button"
                            onClick={() => showToast('Denied for contact form thread')}
                          >
                            Don't allow
                          </button>
                        </div>
                      </div>
                    </div>
                    <p style={{ padding: '10px 14px', margin: 0, fontSize: 12, color: 'var(--muted)' }}>
                      Active chat approvals appear directly in your thread.
                    </p>
                  </div>
                )}
              </div>
            </header>

            {/* View Switching */}
            {currentView === 'skills' ? (
              <SkillsStudio
                skills={skills}
                onSyncSkills={handleSyncSkills}
                onToggleSkill={handleToggleSkill}
                toastMsg={toastMsg}
              />
            ) : currentView === 'memory' ? (
              <SharedMemoryView memoryState={memoryState} />
            ) : currentView === 'activity' ? (
              <ActivityLogView
                events={activityEvents}
                telemetry={{
                  totalEvents: activityEvents.length,
                  toolCalls: 18,
                  approvals: 3,
                  handoffs: 2,
                }}
              />
            ) : mode === 'terminal' ? (
              <TerminalView
                ptyClient={ptyClientRef.current}
                agentName={selectedAgent}
                modelName={selectedModel}
                status={ptyStatus}
              />
            ) : screen === 'home' ? (
              /* Case 2: New Chat Screen with Handoff select */
              <div className="home" data-test="home-screen">
                <div className="greet">
                  <span className="glyph" aria-hidden="true">
                    <b />
                    <b />
                    <b />
                  </span>
                  <h2>What should we build?</h2>
                </div>

                <div className="composer-box">
                  <div className="new-chat-config-bar">
                    <div className="handoff-select-bar">
                      <span>Continue from previous chat:</span>
                      <select
                        id="handoff-select"
                        value={continueFromThread}
                        onChange={e => setContinueFromThread(e.target.value)}
                        aria-label="Select thread context"
                      >
                        <option value="none">None (Start fresh thread)</option>
                        <option value="t_cake">Cake order page (3:20 PM · Claude Code)</option>
                        <option value="t_contact">Fix contact form (1:10 PM · Codex)</option>
                      </select>
                    </div>

                    <button
                      className={`pill-toggle ${autonomousMode ? 'on-warn' : ''}`}
                      type="button"
                      data-test="toggle-skip-permissions"
                      title="Bypass tool approval prompts. Passes --dangerously-skip-permissions flag when spawning CLI."
                      onClick={() => setAutonomousMode(!autonomousMode)}
                    >
                      <span>⚡</span>
                      <span>
                        <code>--dangerously-skip-permissions</code> {autonomousMode ? '(auto-approve)' : ''}
                      </span>
                      <span className="switch-mini">
                        <span className="knob" />
                      </span>
                    </button>
                  </div>

                  <form className="composer" onSubmit={handleComposerSubmit}>
                    <textarea
                      id="prompt"
                      data-test="composer-input"
                      rows={2}
                      value={promptInput}
                      onChange={e => setPromptInput(e.target.value)}
                      placeholder={
                        continueFromThread !== 'none'
                          ? 'Ask the new agent to continue work on the cake order page...'
                          : 'What do you want to build today?'
                      }
                    />
                    <div className="c-row">
                      <button
                        className="c-icon"
                        type="button"
                        aria-label="Add files"
                        onClick={() => showToast('Attach images or files')}
                      >
                        <Icon name="plus" />
                      </button>
                      <button
                        className="c-icon"
                        type="button"
                        data-test="mention-trigger-btn"
                        onClick={() => setMentionMenuOpen(!mentionMenuOpen)}
                        style={{ fontWeight: 600, fontSize: 14, color: 'var(--muted)' }}
                      >
                        @
                      </button>
                      <button
                        className="c-icon"
                        type="button"
                        data-test="slash-trigger-btn"
                        onClick={() => setSlashMenuOpen(!slashMenuOpen)}
                        style={{ fontWeight: 600, fontSize: 14, color: 'var(--muted)' }}
                      >
                        /
                      </button>
                      <button
                        className="folder"
                        type="button"
                        onClick={() => showToast('Project folder: ~/Sites/sweet-crumb')}
                      >
                        <Icon name="folder" className="sm" />
                        <span>sweet-crumb</span>
                        <Icon name="chev" className="sm" />
                      </button>
                      <button
                        className="picker"
                        type="button"
                        id="picker"
                        data-test="agent-picker-btn"
                        onClick={() => setMenuOpen(!menuOpen)}
                      >
                        <span className={`mark m-${selectedAgent}`}>
                          {selectedAgent[0].toUpperCase()}
                        </span>
                        <span className="lbl">{AGENTS_CONFIG[selectedAgent].name}</span>
                        <span className="mdl">{selectedModel}</span>
                        <Icon name="chev" className="sm" />
                      </button>
                      <button className="send" type="submit" data-test="composer-submit">
                        <Icon name="up" />
                      </button>
                    </div>

                    {/* Agent & Model Picker Menu in Home */}
                    {menuOpen && (
                      <div className="menu up" role="menu">
                        {(['claude', 'agy', 'codex'] as AgentId[]).map(k => {
                          const isCurrent = k === selectedAgent;
                          return (
                            <div key={k}>
                              <button
                                className="mi"
                                type="button"
                                onClick={() => setMenuAgent(k)}
                              >
                                <span className={`mark m-${k}`}>{k[0].toUpperCase()}</span>
                                <span className="t">
                                  <strong>{AGENTS_CONFIG[k].name}</strong>
                                  <small>{AGENTS_CONFIG[k].models.length} native models</small>
                                </span>
                                {isCurrent && <span className="tick"><Icon name="check" /></span>}
                              </button>
                              {k === menuAgent && (
                                <div className="models" role="radiogroup">
                                  {AGENTS_CONFIG[k].models.map(([id, n, d]) => (
                                    <button
                                      key={id}
                                      className={`model ${selectedAgent === k && selectedModel === n ? 'on' : ''}`}
                                      type="button"
                                      onClick={() => {
                                        setSelectedAgent(k);
                                        setSelectedModel(n);
                                        setModelsState(prev => ({ ...prev, [k]: id }));
                                        setMenuOpen(false);
                                        showToast(`Switched to ${AGENTS_CONFIG[k].name} (${n})`);
                                      }}
                                    >
                                      <span className="radio" />
                                      <span className="t">
                                        <strong>{n}</strong>
                                        <small>{d}</small>
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <div className="usage">
                          <div className="usage-row">
                            <span>Plan usage</span>
                            <b>72% used</b>
                          </div>
                          <div className="meter warn">
                            <i style={{ width: '72%' }} />
                          </div>
                          <small>Resets 6:00 PM</small>
                        </div>
                      </div>
                    )}

                    {/* Context Mentions Popover in Home */}
                    {mentionMenuOpen && (
                      <MentionPopover
                        query=""
                        onSelect={(item: MentionItem) => {
                          setPromptInput(prev => `${prev}@${item.path} `);
                          setMentionMenuOpen(false);
                        }}
                        onClose={() => setMentionMenuOpen(false)}
                      />
                    )}

                    {/* Skills Slash Popover in Home */}
                    {slashMenuOpen && (
                      <SlashPopover
                        query=""
                        skills={skills}
                        onSelect={(command: string) => {
                          setPromptInput(prev => `${prev}${command} `);
                          setSlashMenuOpen(false);
                        }}
                        onClose={() => setSlashMenuOpen(false)}
                      />
                    )}
                  </form>
                </div>

                <div className="chips">
                  <button
                    className="chip"
                    type="button"
                    onClick={() =>
                      setPromptInput('Build an online ordering page with pickup scheduler')
                    }
                  >
                    <Icon name="globe" className="sm" /> Build order page
                  </button>
                  <button
                    className="chip"
                    type="button"
                    onClick={() => setPromptInput('Fix layout overflow on mobile screens')}
                  >
                    <Icon name="bug" className="sm" /> Fix mobile overlap
                  </button>
                  <button
                    className="chip"
                    type="button"
                    onClick={() => setPromptInput('Explain the database migration flow')}
                  >
                    <Icon name="code" className="sm" /> Explain migrations
                  </button>
                </div>
              </div>
            ) : (
              /* Case 1: Chat Thread with Mockup Conversations */
              <div className="thread" id="thread" data-test="chat-timeline">
                <div className="thread-inner">
                  {/* Message 1 */}
                  <div className="u-msg">
                    Add a page where customers can order a birthday cake and pick it up later.
                  </div>

                  <div className="a-msg">
                    <span className="by">
                      <span className="mark m-claude">C</span>
                      Claude Code <span className="model">Sonnet 5.5</span>
                    </span>
                    <p>I'll create the order page and form, and add it to your site navigation.</p>

                    <button
                      className="tools-sum"
                      type="button"
                      id="tools-sum"
                      aria-expanded={toolsOpen}
                      onClick={() => setToolsOpen(!toolsOpen)}
                    >
                      Ran 4 operations (1 search, 2 files created, 1 edited){' '}
                      <Icon name="right" className="sm chev" />
                    </button>

                    {toolsOpen && (
                      <div className="tool-group">
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="file" className="sm" />
                            <span className="verb">Created</span>
                            <span className="target">app/order/page.tsx</span>
                            <span className="meta">
                              <span className="plus-n">+64</span>
                            </span>
                          </div>
                        </div>
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="pencil" className="sm" />
                            <span className="verb">Edited</span>
                            <span className="target">components/NavBar.tsx</span>
                            <span className="meta">
                              <span className="plus-n">+1</span>
                            </span>
                          </div>
                        </div>
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="term" className="sm" />
                            <span className="verb">Ran</span>
                            <span className="target">npm run build</span>
                            <span className="meta">
                              <span className="st-ok">exit 0</span> · 14.2s
                            </span>
                          </div>
                        </div>
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="term" className="sm" />
                            <span className="verb">Ran</span>
                            <span className="target">node .agents/skills/phone-check/shot.mjs /order</span>
                            <span className="meta">
                              <span className="chiplet">Output removed to free space</span>{' '}
                              <span className="st-ok">exit 0</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    )}

                    <p>
                      Done! Customers can choose cake size, flavor and pickup date. View the preview below:
                    </p>
                    <button
                      className="art"
                      type="button"
                      onClick={() => {
                        setArtifact('order');
                        setArtifactVersion(2);
                        setArtifactTab('preview');
                      }}
                    >
                      <span className="thumb">
                        <Icon name="globe" />
                      </span>
                      <span className="t">
                        <strong>Order a cake page</strong>
                        <small>app/order/page.tsx · v2 · Click to open preview</small>
                      </span>
                    </button>
                  </div>

                  {/* Message 2 */}
                  <div className="u-msg">
                    Looks great. Now save the orders to the database so I can see them later.
                  </div>

                  <div className="a-msg">
                    <span className="by">
                      <span className="mark m-claude">C</span>
                      Claude Code <span className="model">Sonnet 5.5</span>
                    </span>
                    <p>
                      I've updated <code>prisma/schema.prisma</code> to add an Orders table. To apply
                      the change to your database, please confirm below:
                    </p>
                  </div>

                  {/* Inline Approval Card / Execution result */}
                  {autonomousMode ? (
                    <>
                      <div className="tool-group" data-test="tool-row-auto-approved" style={{ marginTop: 6 }}>
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="check" className="sm" />
                            <span className="verb">Ran</span>
                            <span className="target">npx prisma migrate dev --name add_orders</span>
                            <span className="meta">
                              <span
                                className="chiplet"
                                style={{
                                  color: 'var(--warn)',
                                  background: 'var(--warn-soft)',
                                  border: '1px solid var(--warn)',
                                }}
                              >
                                ⚡ auto-approved (--dangerously-skip-permissions)
                              </span>{' '}
                              <span className="st-ok">exit 0</span> · 6.8s
                            </span>
                          </div>
                          <div className="tool-detail">
                            <div className="out">Applied migration 20261015_add_orders{'\n'}Generated Prisma Client</div>
                          </div>
                        </div>
                      </div>
                      <div className="a-msg">
                        <span className="by">
                          <span className="mark m-claude">C</span>Claude Code <span className="model">Sonnet 5.5</span>
                        </span>
                        <p>Orders table is now created in your database (permissions skipped). Next I'll build a private Orders dashboard for the owner.</p>
                      </div>
                    </>
                  ) : inlineStatus === 'pending' ? (
                    <div className="inline-approval" role="alert" data-test="inline-approval-card">
                      <div className="inline-approval-title">
                        <Icon name="clock" className="sm" /> Claude Code is waiting for permission to run:
                      </div>
                      <div className="inline-approval-cmd" data-test="approval-command-text">
                        tool: Bash{'\n'}command: npx prisma migrate dev --name add_orders{'\n'}cwd: ~/Sites/sweet-crumb
                      </div>
                      <div className="btns">
                        <button
                          className="btn sm btn-dark"
                          type="button"
                          data-test="approval-allow-btn"
                          onClick={handleAllowApproval}
                        >
                          <Icon name="check" className="sm" /> Allow (y)
                        </button>
                        <button
                          className="btn sm"
                          type="button"
                          data-test="approval-deny-btn"
                          onClick={handleDenyApproval}
                        >
                          <Icon name="x" className="sm" /> Don't allow (n)
                        </button>
                      </div>
                    </div>
                  ) : inlineStatus === 'allowed' ? (
                    <>
                      <div className="inline-approval" role="alert" data-test="inline-approval-card" style={{ marginBottom: 12 }}>
                        <div className="inline-approval-title">
                          <Icon name="check" className="sm" /> Claude Code permission granted
                        </div>
                        <div className="inline-approval-cmd" data-test="approval-command-text">
                          tool: Bash{'\n'}command: npx prisma migrate dev --name add_orders{'\n'}cwd: ~/Sites/sweet-crumb
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--ok)', fontWeight: 500, marginTop: 8 }}>
                          ✓ Allowed · piped y to stdin
                        </div>
                      </div>
                      <div className="tool-group" style={{ marginTop: 6 }}>
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="check" className="sm" />
                            <span className="verb">Ran</span>
                            <span className="target">npx prisma migrate dev --name add_orders</span>
                            <span className="meta">
                              <span className="st-ok">Allowed · exit 0</span> · 6.8s
                            </span>
                          </div>
                          <div className="tool-detail">
                            <div className="out">Applied migration 20261015_add_orders{'\n'}Generated Prisma Client</div>
                          </div>
                        </div>
                      </div>
                      <div className="a-msg">
                        <span className="by">
                          <span className="mark m-claude">C</span>Claude Code <span className="model">Sonnet 5.5</span>
                        </span>
                        <p>Orders table is now created in your database. Next I'll build a private Orders dashboard for the owner.</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="tool-group" style={{ marginTop: 6 }}>
                        <div className="tool">
                          <div className="tool-row">
                            <Icon name="x" className="sm" />
                            <span className="verb">Blocked</span>
                            <span className="target">npx prisma migrate dev --name add_orders</span>
                            <span className="meta">
                              <span className="st-bad">You chose Don't allow (n)</span>
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="a-msg">
                        <span className="by">
                          <span className="mark m-claude">C</span>Claude Code <span className="model">Sonnet 5.5</span>
                        </span>
                        <p>Understood, I won't run that migration. What would you like to do instead? (For example, we could export orders as CSV without database schema changes).</p>
                      </div>
                    </>
                  )}

                  {/* 1-Click Handoff on Plan Limit */}
                  {limited && !handedTo && (
                    <div className="limit" role="status">
                      <div className="limit-head">
                        <span className="mark m-claude">C</span>
                        <div>
                          <p>Claude Code reached its plan usage limit (resets 6:00 PM).</p>
                          <small>Chorus will launch the next agent with your project context via MCP.</small>
                        </div>
                      </div>
                      <div className="btns">
                        <button
                          className="btn btn-dark"
                          type="button"
                          onClick={() => handleTriggerHandoff('codex')}
                        >
                          <span className="mark m-codex xs">X</span> Continue with Codex
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => handleTriggerHandoff('agy')}
                        >
                          <span className="mark m-agy xs">A</span> Continue with Antigravity
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Conversational Handoff Confirmation */}
                  {handedTo && (
                    <>
                      <div className="handoff-div" data-test="handoff-divider">
                        <span>
                          <span className={`mark m-${handedTo} xs`}>
                            {handedTo[0].toUpperCase()}
                          </span>{' '}
                          Continued with {handedTo === 'codex' ? 'Codex · GPT Codex' : 'Antigravity · Gemini Pro'}
                        </span>
                      </div>
                      <div className="card" data-test="handoff-envelope-card" style={{ padding: '12px 16px', background: 'var(--bubble)', borderRadius: 12 }}>
                        <div style={{ fontWeight: 500, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span>📦 What {handedTo.toUpperCase()} was told</span>
                          <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 'auto' }}>&lt;150 tokens</span>
                        </div>
                        <div style={{ color: 'var(--ink-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                          <div><strong>Recent goal:</strong> Order form responsive layout and Prisma migrations</div>
                          <div><strong>Touched files:</strong> <code>src/components/OrderForm.tsx</code></div>
                          <div style={{ marginTop: 4, fontStyle: 'italic', color: 'var(--muted)' }}>Prompt Envelope transferred via IPC</div>
                        </div>
                      </div>
                      <div className="a-msg">
                        <span className="by">
                          <span className={`mark m-${handedTo}`}>{handedTo[0].toUpperCase()}</span>
                          {AGENTS_CONFIG[handedTo].name} <span className="model">{modelsState[handedTo]}</span>
                        </span>
                        <p>I've loaded the project context from Claude Code via the Prompt Envelope &amp; Chorus MCP bridge:</p>
                        <div className="payload" style={{ background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 12.5 }}>
                          • <strong>Goal:</strong> Online birthday cake ordering for Sweet Crumb Bakery.{'\n'}
                          • <strong>Completed:</strong> Created <code>app/order/page.tsx</code>, linked from menu, and applied database migration for Orders.{'\n'}
                          • <strong>Next up:</strong> Private admin Orders page to view customer submissions.
                        </div>
                        <p>Does this match what you'd like to do, or do you have any specific changes before I proceed?</p>
                        <div className="btns">
                          <button
                            className="btn sm btn-accent"
                            type="button"
                            onClick={() => showToast(`${AGENTS_CONFIG[handedTo].name} is building the admin page`)}
                          >
                            Looks good, proceed
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Dynamically added messages */}
                  {messages.map(m => (
                    <div key={m.id} className={m.role === 'user' ? 'u-msg' : 'a-msg'}>
                      {m.role === 'assistant' && (
                        <div className="by">
                          <span className={`mark xs m-${selectedAgent}`}>
                            {selectedAgent[0].toUpperCase()}
                          </span>
                          <span>{selectedModel}</span>
                        </div>
                      )}
                      <p>{m.content}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Composer Dock */}
            {((currentView === 'chat' && screen !== 'home') || currentView === 'terminal') && (
              <div className="dock">
                <form className="composer" id="composer" onSubmit={handleComposerSubmit}>
                  <label className="sr" htmlFor="prompt">Message</label>
                  <textarea
                    id="prompt"
                    ref={composerTextareaRef}
                    data-test="composer-input"
                    rows={1}
                    value={promptInput}
                    onChange={e => {
                      const val = e.target.value;
                      setPromptInput(val);
                      const cursor = e.target.selectionStart;
                      const lastChar = val[cursor - 1];
                      if (lastChar === '@' && !mentionMenuOpen) {
                        setMentionMenuOpen(true);
                        setSlashMenuOpen(false);
                      } else if (
                        lastChar === '/' &&
                        !slashMenuOpen &&
                        (cursor === 1 || val[cursor - 2] === ' ' || val[cursor - 2] === '\n')
                      ) {
                        setSlashMenuOpen(true);
                        setMentionMenuOpen(false);
                      }
                    }}
                    placeholder={`Reply to ${AGENTS_CONFIG[selectedAgent].name}…`}
                  />

                  <div className="c-row">
                    <button
                      className="c-icon"
                      type="button"
                      aria-label="Add files"
                      onClick={() => showToast('Attach images or files')}
                    >
                      <Icon name="plus" />
                    </button>
                    <button
                      className="c-icon"
                      type="button"
                      data-test="mention-trigger-btn"
                      aria-haspopup="menu"
                      aria-expanded={mentionMenuOpen}
                      onClick={() => setMentionMenuOpen(!mentionMenuOpen)}
                      style={{ fontWeight: 600, fontSize: 14, color: 'var(--muted)' }}
                    >
                      @
                    </button>
                    <button
                      className="c-icon"
                      type="button"
                      data-test="slash-trigger-btn"
                      aria-haspopup="menu"
                      aria-expanded={slashMenuOpen}
                      onClick={() => setSlashMenuOpen(!slashMenuOpen)}
                      style={{ fontWeight: 600, fontSize: 14, color: 'var(--muted)' }}
                    >
                      /
                    </button>

                    <button
                      className="ctx"
                      type="button"
                      title="Context: 34% (68k / 200k tokens)"
                      onClick={() => showToast('Context 34% full')}
                    >
                      <svg className="ring" viewBox="0 0 18 18" aria-hidden="true">
                        <circle className="track" cx="9" cy="9" r="7" />
                        <circle
                          className="val"
                          cx="9"
                          cy="9"
                          r="7"
                          strokeDasharray="14.9 44.0"
                          transform="rotate(-90 9 9)"
                        />
                      </svg>
                      <span>34%</span>
                    </button>

                    <button
                      className="picker"
                      type="button"
                      id="picker"
                      data-test="agent-picker-btn"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={() => {
                        setMenuOpen(!menuOpen);
                        setHandoffMenuOpen(false);
                      }}
                    >
                      <span className={`mark m-${selectedAgent}`}>
                        {selectedAgent[0].toUpperCase()}
                      </span>
                      <span className="lbl">{AGENTS_CONFIG[selectedAgent].name}</span>
                      <span className="mdl">{selectedModel}</span>
                      <Icon name="chev" className="sm" />
                    </button>

                    <button
                      className="btn-handoff"
                      type="button"
                      id="btn-handoff"
                      data-test="handoff-trigger-btn"
                      aria-haspopup="menu"
                      aria-expanded={handoffMenuOpen}
                      onClick={() => {
                        setHandoffMenuOpen(!handoffMenuOpen);
                        setMenuOpen(false);
                      }}
                    >
                      <Icon name="swap" className="sm" />
                      <span>Hand off</span>
                    </button>

                    {agentRunning ? (
                      <button
                        className="send stop"
                        type="button"
                        data-test="composer-stop"
                        title="Stop agent execution (Ctrl+C)"
                        onClick={async () => {
                          if (ptyClientRef.current) {
                            await ptyClientRef.current.kill('SIGINT');
                          }
                          setAgentRunning(false);
                          showToast('Sent SIGINT (Ctrl+C). Agent execution stopped.');
                        }}
                      >
                        <Icon name="stop" />
                      </button>
                    ) : (
                      <button
                        className="send"
                        type="submit"
                        data-test="composer-submit"
                        aria-label="Send"
                      >
                        <Icon name="up" />
                      </button>
                    )}
                  </div>

                  {/* Agent & Model Picker Menu */}
                  {menuOpen && (
                    <div className="menu up" role="menu">
                      {(['claude', 'agy', 'codex'] as AgentId[]).map(k => {
                        const isCurrent = k === selectedAgent;
                        return (
                          <div key={k}>
                            <button
                              className="mi"
                              type="button"
                              onClick={() => setMenuAgent(k)}
                            >
                              <span className={`mark m-${k}`}>{k[0].toUpperCase()}</span>
                              <span className="t">
                                <strong>{AGENTS_CONFIG[k].name}</strong>
                                <small>{AGENTS_CONFIG[k].models.length} native models</small>
                              </span>
                              {isCurrent && <span className="tick"><Icon name="check" /></span>}
                            </button>
                            {k === menuAgent && (
                              <div className="models" role="radiogroup">
                                {AGENTS_CONFIG[k].models.map(([id, n, d]) => (
                                  <button
                                    key={id}
                                    className={`model ${selectedAgent === k && selectedModel === n ? 'on' : ''}`}
                                    type="button"
                                    onClick={() => {
                                      setSelectedAgent(k);
                                      setSelectedModel(n);
                                      setModelsState(prev => ({ ...prev, [k]: id }));
                                      setMenuOpen(false);
                                      showToast(`Switched to ${AGENTS_CONFIG[k].name} (${n})`);
                                    }}
                                  >
                                    <span className="radio" />
                                    <span className="t">
                                      <strong>{n}</strong>
                                      <small>{d}</small>
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <div className="usage">
                        <div className="usage-row">
                          <span>Plan usage</span>
                          <b>72% used</b>
                        </div>
                        <div className="meter warn">
                          <i style={{ width: '72%' }} />
                        </div>
                        <small>Resets 6:00 PM</small>
                      </div>
                    </div>
                  )}

                  {/* Mid-session Handoff Popover */}
                  {handoffMenuOpen && (
                    <HandoffPopover
                      currentAgent={selectedAgent}
                      onSelectAgent={handleTriggerHandoff}
                      onClose={() => setHandoffMenuOpen(false)}
                    />
                  )}

                  {/* Context Mentions Popover */}
                  {mentionMenuOpen && (
                    <MentionPopover
                      query=""
                      onSelect={(item: MentionItem) => {
                        setPromptInput(prev => `${prev}@${item.path} `);
                        setMentionMenuOpen(false);
                      }}
                      onClose={() => setMentionMenuOpen(false)}
                    />
                  )}

                  {/* Skills Slash Popover */}
                  {slashMenuOpen && (
                    <SlashPopover
                      query=""
                      skills={skills}
                      onSelect={(command: string) => {
                        setPromptInput(prev => `${prev}${command} `);
                        setSlashMenuOpen(false);
                      }}
                      onClose={() => setSlashMenuOpen(false)}
                    />
                  )}
                </form>
              </div>
            )}
          </main>

          {/* Right Artifact Canvas Panel */}
          {artifactPanelVisible && (
            <aside
              className="panel"
              style={{
                width: isArtFullscreen ? '100%' : `${artifactPanelWidth}px`,
              }}
              data-test="artifact-canvas-panel"
            >
              {!isArtFullscreen && (
                <div
                  ref={resizerRef}
                  className="resizer"
                  id="art-resizer"
                  data-test="art-resizer"
                  title="Drag to resize panel · Double-click to reset"
                  onMouseDown={e => {
                    isResizingRef.current = true;
                    startXRef.current = e.clientX;
                    startWidthRef.current = artifactPanelWidth;
                    document.querySelector('.app')?.classList.add('art-resizing');
                    e.preventDefault();
                  }}
                  onDoubleClick={() => {
                    setArtifactPanelWidth(580);
                    showToast('Reset artifact panel width to 580px');
                  }}
                >
                  <span className="resizer-grip" />
                </div>
              )}

              <div className="p-head">
                <div className="t">
                  <strong data-test="artifact-title">
                    {activeArtifactItem?.name || 'Order a cake page (order-flow.html)'}
                  </strong>
                  <small data-test="artifact-meta">
                    {activeArtifactItem?.path || '.chorus/artifacts/claude/t_order_cake/order-flow.html'} · v{activeArtifactItem?.version || artifactVersion} · live ·{' '}
                    {isArtFullscreen ? 'fullscreen' : `${artifactPanelWidth}px`}
                  </small>
                </div>

                <div className="v-nav" aria-label="Version history">
                  <button
                    type="button"
                    data-test="artifact-ver-1-btn"
                    disabled={artifactVersion === 1}
                    onClick={() => setArtifactVersion(1)}
                  >
                    ‹
                  </button>
                  <span>v{artifactVersion} of 2</span>
                  <button
                    type="button"
                    data-test="artifact-ver-2-btn"
                    disabled={artifactVersion === 2}
                    onClick={() => setArtifactVersion(2)}
                  >
                    ›
                  </button>
                </div>

                <div className="seg" role="group">
                  <button
                    type="button"
                    data-test="artifact-tab-preview"
                    aria-pressed={artifactTab === 'preview'}
                    onClick={() => setArtifactTab('preview')}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    data-test="artifact-tab-code"
                    aria-pressed={artifactTab === 'code'}
                    onClick={() => setArtifactTab('code')}
                  >
                    Code
                  </button>
                  <button
                    type="button"
                    data-test="artifact-tab-diff"
                    aria-pressed={artifactTab === 'diff'}
                    onClick={() => setArtifactTab('diff')}
                  >
                    Diff
                  </button>
                </div>

                <button
                  className="ghost-icon"
                  type="button"
                  data-test="canvas-reset-width"
                  title="Reset panel width to 580px"
                  onClick={() => {
                    setArtifactPanelWidth(580);
                    showToast('Reset artifact panel width to 580px');
                  }}
                >
                  <Icon name="sync" className="sm" />
                </button>
                <button
                  className="ghost-icon"
                  type="button"
                  data-test="canvas-fullscreen-btn"
                  title={isArtFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  onClick={() => setIsArtFullscreen(!isArtFullscreen)}
                >
                  <Icon name={isArtFullscreen ? 'compress' : 'expand'} className="sm" />
                </button>
                <button
                  className="ghost-icon"
                  type="button"
                  data-test="canvas-close-btn"
                  aria-label="Close panel"
                  onClick={() => {
                    setArtifact(null);
                    setActiveArtifactItem(null);
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>

              <div className="p-body" data-test="artifact-body">
                {artifactTab === 'preview' ? (
                  activeArtifactItem?.content ? (
                    <iframe
                      data-test="artifact-iframe"
                      title={activeArtifactItem.name}
                      srcDoc={activeArtifactItem.content}
                      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
                    />
                  ) : artifactVersion === 1 ? (
                    <div className="site">
                      <div className="site-nav">
                        <b>Sweet Crumb Bakery</b>
                        <nav>
                          <span>Menu</span>
                          <span className="on">Order</span>
                        </nav>
                      </div>
                      <div className="site-body">
                        <h5>Order a cake (v1 basic)</h5>
                        <div className="field">
                          Name<span>Customer Name</span>
                        </div>
                        <div className="field">
                          Cake size<span>8 inch</span>
                        </div>
                        <span className="site-btn">Submit</span>
                      </div>
                    </div>
                  ) : (
                    <div className="site">
                      <div className="site-nav">
                        <b>Sweet Crumb Bakery</b>
                        <nav>
                          <span>Menu</span>
                          <span className="on">Order a cake</span>
                          <span>About</span>
                        </nav>
                      </div>
                      <div className="site-body">
                        <h5>Order a birthday cake</h5>
                        <p className="lead">Tell us what you'd like and pickup date. We'll confirm via email.</p>
                        <div className="field">
                          Your name<span>Mai Tran</span>
                        </div>
                        <div className="two">
                          <div className="field">
                            Cake size<span>8 inch · serves 10–12</span>
                          </div>
                          <div className="field">
                            Flavor<span>Vanilla raspberry</span>
                          </div>
                        </div>
                        <div className="field">
                          Pickup time<span>Sat, Oct 24 · 10:00 AM</span>
                        </div>
                        <span className="site-btn">Place order</span>
                      </div>
                    </div>
                  )
                ) : artifactTab === 'code' ? (
                  <pre className="src" data-test="artifact-source">
                    {artifactVersion === 1
                      ? `export default function OrderPage() {\n  return (\n    <section>\n      <h1>Order a cake</h1>\n      <OrderForm />\n    </section>\n  );\n}`
                      : `export default function OrderPage() {\n  return (\n    <section className="order">\n      <h1>Order a birthday cake</h1>\n      <p>Tell us what you'd like and pickup date.</p>\n      <OrderForm fields={["name", "size", "flavor", "pickup"]} />\n    </section>\n  );\n}`}
                  </pre>
                ) : (
                  <div className="diff-view" data-test="artifact-diff">
                    <div className="head-line">@@ -1,7 +1,10 @@ app/order/page.tsx (v1 → v2)</div>
                    <div> export default function OrderPage() {'{'}</div>
                    <div>   return (</div>
                    <div className="del-line">-    &lt;section&gt;</div>
                    <div className="add-line">+    &lt;section className="order"&gt;</div>
                    <div className="del-line">-      &lt;h1&gt;Order a cake&lt;/h1&gt;</div>
                    <div className="add-line">+      &lt;h1&gt;Order a birthday cake&lt;/h1&gt;</div>
                    <div className="add-line">+      &lt;p&gt;Tell us what you'd like and pickup date.&lt;/p&gt;</div>
                    <div className="del-line">-      &lt;OrderForm /&gt;</div>
                    <div className="add-line">+      &lt;OrderForm fields={["name", "size", "flavor", "pickup"]} /&gt;</div>
                    <div>    &lt;/section&gt;</div>
                    <div>   );</div>
                    <div> {'}'}</div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>

      {/* Floating Toast Notification */}
      {toastMsg && (
        <div className="toast" data-test="toast-notification">
          {toastMsg}
        </div>
      )}
    </>
  );
}

export default App;

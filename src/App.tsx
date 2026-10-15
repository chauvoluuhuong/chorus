import { useState, useEffect, useRef } from 'react';
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
import { ComposerDock } from './components/ComposerDock';
import { InlineApprovalCard } from './components/InlineApprovalCard';
import { ArtifactPanel } from './components/ArtifactPanel';
import { SkillsStudio } from './components/SkillsStudio';
import { SharedMemoryView } from './components/SharedMemoryView';
import { ActivityLogView } from './components/ActivityLogView';

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
    id: 'thread-1',
    title: 'Design token alignment',
    agent: 'claude',
    model: 'Sonnet 3.7',
    autonomous: false,
    createdAt: '10 mins ago',
    updatedAt: '10 mins ago',
  },
  {
    id: 'thread-2',
    title: 'PTY Master/Slave Stream',
    agent: 'claude',
    model: 'Sonnet 3.7',
    autonomous: true,
    createdAt: 'Just now',
    updatedAt: 'Just now',
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
  const [threads, setThreads] = useState<Thread[]>(INITIAL_THREADS);
  const [activeThreadId, setActiveThreadId] = useState<string>('thread-2');
  const [currentView, setCurrentView] = useState<'chat' | 'terminal' | 'skills' | 'memory' | 'activity'>('terminal');
  const [ptyStatus, setPtyStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'terminated'>('disconnected');
  const [autonomousMode, setAutonomousMode] = useState<boolean>(false);
  const [artifactPanelVisible, setArtifactPanelVisible] = useState<boolean>(false);
  const [artifactPanelWidth, setArtifactPanelWidth] = useState<number>(580);
  const [isArtFullscreen, setIsArtFullscreen] = useState<boolean>(false);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem | null>(null);
  const [activeArtifactVersion, setActiveArtifactVersion] = useState<number>(1);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [skills, setSkills] = useState<SkillBundle[]>(INITIAL_SKILLS);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('claude');
  const [selectedModel, setSelectedModel] = useState<string>('Sonnet 3.7');
  const [lastPromptEnvelope, setLastPromptEnvelope] = useState<PromptEnvelope | null>(null);
  const [memoryState, setMemoryState] = useState<SharedMemoryState>(INITIAL_MEMORY_STATE);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>(INITIAL_ACTIVITY_EVENTS);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const ptyClientRef = useRef<PtyClient | null>(null);
  const stateRef = useRef<ChorusAppState>({
    threads,
    activeThreadId,
    currentView,
    ptyStatus,
    autonomousMode,
    artifactPanelVisible,
    artifactPanelWidth,
    activeArtifact,
    activeArtifactVersion,
    pendingApprovals,
    skills,
    selectedAgent,
    selectedModel,
    lastPromptEnvelope,
    memoryState,
    activityEvents,
  });

  // Keep stateRef fresh for test harness
  useEffect(() => {
    stateRef.current = {
      threads,
      activeThreadId,
      currentView,
      ptyStatus,
      autonomousMode,
      artifactPanelVisible,
      artifactPanelWidth,
      activeArtifact,
      activeArtifactVersion,
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
    ptyStatus,
    autonomousMode,
    artifactPanelVisible,
    artifactPanelWidth,
    activeArtifact,
    activeArtifactVersion,
    pendingApprovals,
    skills,
    selectedAgent,
    selectedModel,
    lastPromptEnvelope,
    memoryState,
    activityEvents,
  ]);

  const spawnPtySession = async (options: PtySpawnOptions) => {
    if (ptyClientRef.current) {
      ptyClientRef.current.destroy();
    }

    const client = new PtyClient();
    ptyClientRef.current = client;
    setPtyStatus('connecting');
    stateRef.current = { ...stateRef.current, ptyStatus: 'connecting' };

    client.onData(data => {
      window.__CHORUS_HARNESS__?.emit('pty:data', data);

      // Check for interactive approval prompt
      const approvalMatch = data.match(/Authorize command:\s*(.*?)\s*\[y\/n\]:/i);
      if (approvalMatch) {
        const command = approvalMatch[1].trim();
        const approval: ApprovalRequest = {
          id: `appr-${Date.now()}`,
          threadId: activeThreadId,
          toolCallId: `tool-${Date.now()}`,
          command,
          summary: `Privileged command execution: ${command}`,
          risk: 'Modifies database schemas / executes system commands',
          status: 'pending',
          timestamp: 'Just now',
        };
        setPendingApprovals(prev => [...prev, approval]);
        stateRef.current = {
          ...stateRef.current,
          pendingApprovals: [...stateRef.current.pendingApprovals, approval],
        };
        setMessages(prev => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            threadId: activeThreadId,
            role: 'assistant',
            content: `The agent requests authorization to execute a privileged command:`,
            approvalRequest: approval,
            timestamp: 'Just now',
          },
        ]);
        setCurrentView('chat');
        window.__CHORUS_HARNESS__?.emit('approval:requested', approval);
      }

      // Check for auto-approved execution
      if (data.includes('auto-approved --dangerously-skip-permissions')) {
        setMessages(prev => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            threadId: activeThreadId,
            role: 'assistant',
            content: '⚡ auto-approved (--dangerously-skip-permissions)',
            timestamp: 'Just now',
            toolCalls: [
              {
                id: `tool-${Date.now()}`,
                verb: 'Execute',
                target: 'npx prisma migrate dev',
                status: 'ok',
                autoApproved: true,
              },
            ],
          },
        ]);
        setCurrentView('chat');
      }
    });

    client.onExit(code => {
      setPtyStatus('terminated');
      stateRef.current = { ...stateRef.current, ptyStatus: 'terminated' };
      window.__CHORUS_HARNESS__?.emit('pty:exit', code);
    });

    try {
      await client.spawn(options);
      setPtyStatus('connected');
      stateRef.current = { ...stateRef.current, ptyStatus: 'connected' };
    } catch (err) {
      setPtyStatus('terminated');
      stateRef.current = { ...stateRef.current, ptyStatus: 'terminated' };
      console.error('PTY spawn failed:', err);
    }
  };

  const handleAllowApproval = async (approval: ApprovalRequest) => {
    if (ptyClientRef.current) {
      await ptyClientRef.current.write('y\n');
    }
    setPendingApprovals(prev => prev.filter(a => a.id !== approval.id));
    stateRef.current = {
      ...stateRef.current,
      pendingApprovals: stateRef.current.pendingApprovals.filter(a => a.id !== approval.id),
    };
    setMessages(prev =>
      prev.map(m => {
        if (m.approvalRequest?.id === approval.id) {
          return {
            ...m,
            approvalRequest: { ...m.approvalRequest, status: 'allowed' },
          };
        }
        return m;
      }),
    );
  };

  const handleDenyApproval = async (approval: ApprovalRequest) => {
    if (ptyClientRef.current) {
      await ptyClientRef.current.write('n\n');
    }
    setPendingApprovals(prev => prev.filter(a => a.id !== approval.id));
    stateRef.current = {
      ...stateRef.current,
      pendingApprovals: stateRef.current.pendingApprovals.filter(a => a.id !== approval.id),
    };
    setMessages(prev =>
      prev.map(m => {
        if (m.approvalRequest?.id === approval.id) {
          return {
            ...m,
            approvalRequest: { ...m.approvalRequest, status: 'denied' },
          };
        }
        return m;
      }),
    );
  };

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    toastTimerRef.current = setTimeout(() => {
      setToastMsg(null);
    }, 4000);
  };

  const handleSyncSkills = async () => {
    try {
      const res = await fetch('/api/skills/scan', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const found: SkillBundle[] = data.skills || [];
        setSkills(prev => {
          const map = new Map(prev.map(s => [s.id, s]));
          for (const item of found) {
            map.set(item.id, {
              ...item,
            });
          }
          const updated = Array.from(map.values());
          stateRef.current = { ...stateRef.current, skills: updated };
          return updated;
        });
        const msg = `Scanned ${data.scannedCount} skill folders · ${data.newCount} new skill${data.newCount === 1 ? '' : 's'} imported`;
        showToast(msg);
        window.__CHORUS_HARNESS__?.emit('skills:scanned', data);
      }
    } catch (err) {
      console.error('Skill scan failed:', err);
    }
  };

  const handleToggleSkill = async (skillId: string, active: boolean) => {
    const currentSkill = stateRef.current.skills.find(s => s.id === skillId);
    const content =
      currentSkill?.content ||
      `# ${skillId} Skill\nGenerate accessible UI components styled with Tailwind CSS.`;

    const updated = stateRef.current.skills.map(s => {
      if (s.id === skillId) {
        return { ...s, active };
      }
      return s;
    });
    setSkills(updated);
    stateRef.current = { ...stateRef.current, skills: updated };

    try {
      await fetch('/api/skills/materialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: skillId,
          active,
          content,
        }),
      });
      window.__CHORUS_HARNESS__?.emit('skill:toggled', { id: skillId, active });
    } catch (err) {
      console.error('Skill materialize failed:', err);
    }
  };

  // Setup Test Harness
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
        setArtifactPanelVisible: v => setArtifactPanelVisible(v),
        setActiveArtifact: a => {
          setActiveArtifact(a);
          if (a) setArtifactPanelVisible(true);
        },
        setActiveArtifactVersion: v => setActiveArtifactVersion(v),
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

  // Live OS Artifact Watcher stream
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
          setActiveArtifact(item);
          setArtifactPanelVisible(true);
          stateRef.current = {
            ...stateRef.current,
            activeArtifact: item,
            artifactPanelVisible: true,
          };
          window.__CHORUS_HARNESS__?.emit('artifact:updated', item);
        } catch (err) {
          console.error('Artifact update parse failed:', err);
        }
      });
    } catch {
      // ignore
    }

    return () => {
      es?.close();
    };
  }, [activeThreadId, selectedAgent]);

  const handleTriggerHandoff = async (targetAgent: AgentId) => {
    const targetModel =
      targetAgent === 'codex' ? 'GPT Codex' : targetAgent === 'agy' ? 'Gemini 2.5 Pro' : 'Sonnet 3.7';
    const targetName =
      targetAgent === 'codex' ? 'Codex' : targetAgent === 'agy' ? 'Antigravity' : 'Claude';

    const envelope: PromptEnvelope = {
      turn_id: `turn-handoff-${Date.now()}`,
      target_engine: targetAgent,
      user_prompt: `[HANDOFF FROM ${selectedAgent.toUpperCase()}]: Continued goal 'Order form responsive layout and Prisma migrations'. Touched files: ['src/components/OrderForm.tsx']. Recent task: Complete tests and verify UI layout.`,
      context_files: ['src/components/OrderForm.tsx'],
      context_artifacts: activeArtifact ? [activeArtifact.path] : [],
      on_demand_skills: ['tailwind-ui'],
      shared_memory_budget_tokens: 4000,
    };

    setSelectedAgent(targetAgent);
    setSelectedModel(targetModel);
    setLastPromptEnvelope(envelope);
    stateRef.current = {
      ...stateRef.current,
      selectedAgent: targetAgent,
      selectedModel: targetModel,
      lastPromptEnvelope: envelope,
    };

    setMessages(prev => [
      ...prev,
      {
        id: `msg-handoff-${Date.now()}`,
        threadId: activeThreadId,
        role: 'handoff',
        content: `Continued with ${targetName} · ${targetModel}`,
        agent: targetAgent,
        model: targetModel,
        timestamp: 'Just now',
      },
    ]);
    setCurrentView('chat');

    // Halt previous PTY session gracefully
    if (ptyClientRef.current) {
      await ptyClientRef.current.kill('SIGINT');
    }

    // Spawn target PTY session
    await spawnPtySession({
      id: `handoff-${targetAgent}-${Date.now()}`,
      command: 'node',
      args: ['tests/e2e/stubs/cli-stub.js', '--agent', targetAgent],
      env: {
        CHORUS_TARGET_ENGINE: targetAgent,
        CHORUS_PROMPT_ENVELOPE: JSON.stringify(envelope),
      },
    });

    window.__CHORUS_HARNESS__?.emit('handoff:completed', { targetAgent, envelope });
  };

  const handleStopPty = async () => {
    if (ptyClientRef.current) {
      await ptyClientRef.current.kill('SIGINT');
    }
  };

  const handleSendPrompt = async (prompt: string, envelope: PromptEnvelope) => {
    if (!prompt.trim()) return;

    const newTurn: ChatMessage = {
      id: `msg-${Date.now()}`,
      threadId: activeThreadId,
      role: 'user',
      content: prompt,
      timestamp: 'Just now',
    };
    setMessages(prev => [...prev, newTurn]);

    setLastPromptEnvelope(envelope);
    stateRef.current = { ...stateRef.current, lastPromptEnvelope: envelope };

    // If PTY not running, spawn it
    if (ptyStatus !== 'connected') {
      const args = ['tests/e2e/stubs/cli-stub.js'];
      if (autonomousMode) {
        args.push('--dangerously-skip-permissions');
      }
      await spawnPtySession({
        id: `sess-${Date.now()}`,
        command: 'node',
        args,
      });
    } else {
      ptyClientRef.current?.write(prompt + '\n');
    }
  };

  const activeThread = threads.find(t => t.id === activeThreadId);

  return (
    <div className={`window ${theme}`} data-theme={theme}>
      <div className={`app ${artifactPanelVisible ? '' : 'art-collapsed'} ${isArtFullscreen ? 'art-full' : ''}`}>
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="sb-head">
            <span className="wordmark">
              <span className="glyph">
                <b />
                <b />
                <b />
              </span>
              Chorus
            </span>
          </div>

          <button
            className="nav new"
            data-test="new-chat-btn"
            onClick={() => {
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
              setCurrentView('terminal');
            }}
          >
            <span className="plus">+</span>
            <span>New chat</span>
          </button>

          <button
            className={`nav ${currentView === 'terminal' ? 'on' : ''}`}
            onClick={() => setCurrentView('terminal')}
            data-test="nav-terminal"
          >
            Terminal (PTY)
          </button>

          <button
            className={`nav ${currentView === 'chat' ? 'on' : ''}`}
            onClick={() => setCurrentView('chat')}
            data-test="nav-chat"
          >
            Chat Stream
          </button>

          <button
            className={`nav ${currentView === 'skills' ? 'on' : ''}`}
            onClick={() => setCurrentView('skills')}
            data-test="nav-skills"
          >
            Skills Studio
          </button>

          <button
            className={`nav ${currentView === 'memory' ? 'on' : ''}`}
            onClick={() => setCurrentView('memory')}
            data-test="nav-memory"
          >
            Shared Memory
          </button>

          <button
            className={`nav ${currentView === 'activity' ? 'on' : ''}`}
            onClick={() => setCurrentView('activity')}
            data-test="nav-activity"
          >
            Activity Log
          </button>

          <div className="sb-label">Recent Chats</div>
          <div className="recents">
            {threads.map(t => (
              <button
                key={t.id}
                className={`recent ${t.id === activeThreadId ? 'on' : ''}`}
                onClick={() => setActiveThreadId(t.id)}
                data-test={`thread-item-${t.id}`}
              >
                <span>{t.title}</span>
                <span className={`mark xs m-${t.agent}`}>{t.agent[0].toUpperCase()}</span>
              </button>
            ))}
          </div>

          <div className="sb-foot">
            <div className="theme-pill">
              <button
                className={theme === 'light' ? 'on' : ''}
                onClick={() => setTheme('light')}
                data-test="theme-light-btn"
              >
                ☀️
              </button>
              <button
                className={theme === 'dark' ? 'on' : ''}
                onClick={() => setTheme('dark')}
                data-test="theme-dark-btn"
              >
                🌙
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content Pane */}
        <main className="main">
          {/* Topbar */}
          <header className="topbar">
            <button className="title-btn" data-test="thread-title-btn">
              <strong>{activeThread?.title || 'Active Session'}</strong>
              <span className="sub">· {selectedModel}</span>
            </button>

            <div className="top-right">
              <button
                className="bell"
                data-test="header-bell-btn"
                aria-label="Notifications & Approvals"
              >
                🔔
                {pendingApprovals.length > 0 && (
                  <span className="badge" data-test="header-bell-badge">
                    {pendingApprovals.length}
                  </span>
                )}
              </button>
            </div>
          </header>

          {/* Body View */}
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
          ) : currentView === 'terminal' ? (
            <TerminalView
              ptyClient={ptyClientRef.current}
              agentName={selectedAgent}
              modelName={selectedModel}
              status={ptyStatus}
            />
          ) : (
            <div className="thread" data-test="chat-timeline">
              <div className="thread-inner">
                {messages.map(m =>
                  m.role === 'handoff' ? (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        margin: '12px 0',
                        width: '100%',
                      }}
                    >
                      <div className="handoff-div" data-test="handoff-divider">
                        <span>{m.content}</span>
                      </div>
                      <div
                        className="card"
                        data-test="handoff-envelope-card"
                        style={{
                          padding: '12px 16px',
                          background: 'var(--bubble)',
                          borderRadius: 12,
                          fontSize: 13,
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 500,
                            marginBottom: 6,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span>📦 What {m.agent ? m.agent.toUpperCase() : 'Agent'} was told</span>
                          <span
                            style={{
                              fontSize: 11,
                              color: 'var(--muted)',
                              marginLeft: 'auto',
                            }}
                          >
                            &lt;150 tokens
                          </span>
                        </div>
                        <div
                          style={{
                            color: 'var(--ink-2)',
                            fontSize: 12.5,
                            lineHeight: 1.55,
                          }}
                        >
                          <div>
                            <strong>Recent goal:</strong> Order form responsive layout and Prisma
                            migrations
                          </div>
                          <div>
                            <strong>Touched files:</strong>{' '}
                            <code>src/components/OrderForm.tsx</code>
                          </div>
                          <div
                            style={{
                              marginTop: 4,
                              fontStyle: 'italic',
                              color: 'var(--muted)',
                            }}
                          >
                            Prompt Envelope transferred via IPC
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={m.id}
                      className={m.role === 'user' ? 'u-msg' : 'a-msg'}
                      data-test={`msg-${m.id}`}
                    >
                      {m.role === 'assistant' && (
                        <div className="by">
                          <span className={`mark xs m-${m.agent || selectedAgent}`}>
                            {(m.agent || selectedAgent)[0].toUpperCase()}
                          </span>
                          <span>{m.model || selectedModel}</span>
                        </div>
                      )}
                      <p>{m.content}</p>

                      {m.toolCalls &&
                        m.toolCalls.map(t => (
                          <div
                            key={t.id}
                            className="tool-group"
                            data-test="tool-row-auto-approved"
                            style={{ margin: '6px 0' }}
                          >
                            <div className="tool-row">
                              <span>⚡</span>
                              <span className="verb">{t.verb}</span>
                              <span className="target">{t.target}</span>
                              <span className="st-ok">
                                ⚡ auto-approved (--dangerously-skip-permissions)
                              </span>
                            </div>
                          </div>
                        ))}

                      {m.approvalRequest && (
                        <InlineApprovalCard
                          approval={m.approvalRequest}
                          onAllow={handleAllowApproval}
                          onDeny={handleDenyApproval}
                        />
                      )}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}

          {/* Composer Dock */}
          {(currentView === 'chat' || currentView === 'terminal') && (
            <ComposerDock
              selectedAgent={selectedAgent}
              selectedModel={selectedModel}
              autonomousMode={autonomousMode}
              ptyConnected={ptyStatus === 'connected'}
              skills={skills}
              onToggleAutonomous={() => setAutonomousMode(!autonomousMode)}
              onSelectAgent={agent => setSelectedAgent(agent)}
              onTriggerHandoff={handleTriggerHandoff}
              onSubmitPrompt={handleSendPrompt}
              onStopPty={handleStopPty}
            />
          )}
        </main>

        {/* Right Artifact Canvas Panel */}
        {artifactPanelVisible && (
          <ArtifactPanel
            artifact={activeArtifact}
            version={activeArtifactVersion}
            width={artifactPanelWidth}
            isFullscreen={isArtFullscreen}
            onWidthChange={w => {
              setArtifactPanelWidth(w);
              stateRef.current = { ...stateRef.current, artifactPanelWidth: w };
            }}
            onResetWidth={() => {
              setArtifactPanelWidth(580);
              stateRef.current = { ...stateRef.current, artifactPanelWidth: 580 };
            }}
            onToggleFullscreen={() => setIsArtFullscreen(!isArtFullscreen)}
            onClose={() => setArtifactPanelVisible(false)}
          />
        )}
      </div>
    </div>
  );
}

export default App;

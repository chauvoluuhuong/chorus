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
} from './types';
import { PtyClient, type PtySpawnOptions } from './services/pty';
import { createHarness } from './harness';
import { TerminalView } from './components/TerminalView';

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
    active: true,
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

export function App() {
  const [threads, setThreads] = useState<Thread[]>(INITIAL_THREADS);
  const [activeThreadId, setActiveThreadId] = useState<string>('thread-2');
  const [currentView, setCurrentView] = useState<'chat' | 'terminal' | 'skills' | 'memory' | 'activity'>('terminal');
  const [ptyStatus, setPtyStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'terminated'>('disconnected');
  const [autonomousMode, setAutonomousMode] = useState<boolean>(false);
  const [artifactPanelVisible, setArtifactPanelVisible] = useState<boolean>(false);
  const [artifactPanelWidth, setArtifactPanelWidth] = useState<number>(580);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem | null>(null);
  const [activeArtifactVersion, setActiveArtifactVersion] = useState<number>(1);
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [skills, setSkills] = useState<SkillBundle[]>(INITIAL_SKILLS);
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('claude');
  const [selectedModel, setSelectedModel] = useState<string>('Sonnet 3.7');
  const [lastPromptEnvelope, setLastPromptEnvelope] = useState<PromptEnvelope | null>(null);

  const [inputPrompt, setInputPrompt] = useState<string>('');
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

  // Setup Test Harness
  useEffect(() => {
    const harness = createHarness(
      () => stateRef.current,
      {
        setAutonomousMode: enabled => setAutonomousMode(enabled),
        setArtifactPanelWidth: w => setArtifactPanelWidth(w),
        resetArtifactPanelWidth: () => setArtifactPanelWidth(580),
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
        triggerMidSessionHandoff: async (targetAgent: AgentId) => {
          setSelectedAgent(targetAgent);
          window.__CHORUS_HARNESS__?.emit('handoff:completed', { targetAgent });
        },
        simulateFileDrop: async () => {},
        getPtyClient: () => ptyClientRef.current,
        spawnPty: spawnPtySession,
        setPromptEnvelope: envelope => setLastPromptEnvelope(envelope),
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

  const handleStopPty = async () => {
    if (ptyClientRef.current) {
      await ptyClientRef.current.kill('SIGINT');
    }
  };

  const handleSendPrompt = async () => {
    if (!inputPrompt.trim()) return;

    const newTurn: ChatMessage = {
      id: `msg-${Date.now()}`,
      threadId: activeThreadId,
      role: 'user',
      content: inputPrompt,
      timestamp: 'Just now',
    };
    setMessages(prev => [...prev, newTurn]);

    // Build prompt envelope
    const envelope: PromptEnvelope = {
      turn_id: `turn-${Date.now()}`,
      target_engine: selectedAgent,
      user_prompt: inputPrompt,
      context_files: [],
      context_artifacts: [],
      on_demand_skills: [],
      shared_memory_budget_tokens: 4000,
    };
    setLastPromptEnvelope(envelope);

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
      ptyClientRef.current?.write(inputPrompt + '\n');
    }

    setInputPrompt('');
  };

  const activeThread = threads.find(t => t.id === activeThreadId);

  return (
    <div className={`window ${theme}`} data-theme={theme}>
      <div className={`app ${artifactPanelVisible ? '' : 'art-collapsed'}`}>
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
          {currentView === 'terminal' ? (
            <TerminalView
              ptyClient={ptyClientRef.current}
              agentName={selectedAgent}
              modelName={selectedModel}
              status={ptyStatus}
            />
          ) : (
            <div className="thread" data-test="chat-timeline">
              <div className="thread-inner">
                {messages.map(m => (
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
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Composer Dock */}
          <div className="dock">
            <div className="composer">
              <textarea
                data-test="composer-input"
                rows={2}
                placeholder="Message Claude, ask questions, or run commands..."
                value={inputPrompt}
                onChange={e => setInputPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendPrompt();
                  }
                }}
              />

              <div className="c-row">
                {/* Autonomous Mode Toggle */}
                <button
                  type="button"
                  className={`pill-toggle ${autonomousMode ? 'on-warn' : ''}`}
                  onClick={() => setAutonomousMode(!autonomousMode)}
                  data-test="toggle-skip-permissions"
                  title="Toggle autonomous permissions bypass"
                >
                  <span className="switch-mini">
                    <span className="knob" />
                  </span>
                  <span>{autonomousMode ? '⚡ auto-approve' : 'Safe mode'}</span>
                </button>

                {/* Handoff Trigger Button */}
                <button
                  type="button"
                  className="btn-handoff"
                  data-test="handoff-trigger-btn"
                  title="Switch to another engine with context handoff"
                >
                  ⇄ Hand off
                </button>

                {/* Agent & Model Picker Button */}
                <button
                  type="button"
                  className="picker"
                  data-test="agent-picker-btn"
                  onClick={() => {
                    const nextAgent =
                      selectedAgent === 'claude' ? 'agy' : selectedAgent === 'agy' ? 'codex' : 'claude';
                    setSelectedAgent(nextAgent);
                  }}
                >
                  <span className={`mark xs m-${selectedAgent}`}>{selectedAgent[0].toUpperCase()}</span>
                  <span className="lbl">{selectedAgent.toUpperCase()}</span>
                  <span className="mdl">{selectedModel}</span>
                </button>

                {/* Submit / Stop Buttons */}
                {ptyStatus === 'connected' ? (
                  <button
                    type="button"
                    className="send stop"
                    data-test="composer-stop"
                    onClick={handleStopPty}
                    title="Send SIGINT (Ctrl+C)"
                  >
                    ⏹
                  </button>
                ) : (
                  <button
                    type="button"
                    className="send"
                    data-test="composer-submit"
                    onClick={handleSendPrompt}
                    title="Send Prompt"
                  >
                    ↑
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Right Artifact Canvas Panel */}
        {artifactPanelVisible && (
          <aside
            className="panel"
            style={{ width: `${artifactPanelWidth}px` }}
            data-test="artifact-canvas-panel"
          >
            <div
              className="resizer"
              id="art-resizer"
              data-test="art-resizer"
              onDoubleClick={() => setArtifactPanelWidth(580)}
            >
              <div className="resizer-grip" />
            </div>
            <div className="p-head">
              <div className="t">
                <strong>{activeArtifact?.name || 'Artifact Viewer'}</strong>
                <small>v{activeArtifactVersion}</small>
              </div>
              <button
                className="btn sm"
                data-test="canvas-reset-width"
                onClick={() => setArtifactPanelWidth(580)}
              >
                Reset
              </button>
              <button
                className="btn sm"
                data-test="canvas-fullscreen-btn"
                onClick={() => setArtifactPanelWidth(window.innerWidth)}
              >
                Fullscreen
              </button>
            </div>
            <div className="p-body">
              <pre className="src">{activeArtifact?.content || 'No artifact selected.'}</pre>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default App;

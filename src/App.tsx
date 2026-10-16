import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
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
  ToolCallSummary,
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

/* ---------- Agent Registry & Real CLI Configurations ---------- */
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
  agy: {
    name: 'Antigravity',
    l: 'A',
    cli: 'agy',
    account: 'Google',
    models: [
      ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)', 'Ultra-fast lightweight execution.'],
      ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'Fast execution with deeper reasoning.'],
      ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)', 'Balanced multi-file reasoning and planning.'],
      ['gemini-4-argon-high', 'Gemini 4 Argon (High)', 'Maximum capability reasoning.'],
    ],
    usage: {
      limit: null,
      quotaStatus: 'Standard Quota · Active',
      chat: '0',
      ctx: 0,
      ctxOf: '0 / 1M',
    },
  },
  claude: {
    name: 'Claude Code',
    l: 'C',
    cli: 'claude',
    account: 'Anthropic',
    models: [
      ['sonnet', 'Sonnet 5.5', 'Fast and capable. Default.'],
      ['opus', 'Opus 5.5', 'Most capable.'],
      ['haiku', 'Haiku 5.5', 'Quickest for lightweight edits.'],
    ],
    usage: { limit: null, quotaStatus: 'Active', chat: '0', ctx: 0, ctxOf: '0 / 200k' },
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
    usage: { limit: null, quotaStatus: 'Active', chat: '0', ctx: 0, ctxOf: '0 / 400k' },
  },
};

const EMPTY_MEMORY_STATE: SharedMemoryState = {
  workingMemory: [],
  projectDocs: [],
  budgetUsedTokens: 0,
  budgetMaxTokens: 1000000,
  ringBufferCapacity: 500,
  ringBufferUsed: 0,
};

export function App() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('light');
  const [currentView, setCurrentView] = useState<'chat' | 'terminal' | 'skills' | 'memory' | 'activity'>('chat');
  const [screen, setScreen] = useState<'home' | 'thread'>('thread');
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat');

  const [selectedAgent, setSelectedAgent] = useState<AgentId>('agy');
  const [selectedModel, setSelectedModel] = useState<string>('Gemini 3.8 Flash (Low)');
  const [modelsState, setModelsState] = useState<Record<AgentId, string>>({
    agy: 'gemini-3.8-flash-low',
    claude: 'sonnet',
    codex: 'codex',
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAgent, setMenuAgent] = useState<AgentId>('agy');
  const [handoffMenuOpen, setHandoffMenuOpen] = useState(false);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);

  const [autonomousMode, setAutonomousMode] = useState<boolean>(true);
  const [agentRunning, setAgentRunning] = useState<boolean>(false);

  // Artifact Canvas & Sidebar State (no mock artifacts)
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [activeArtifactItem, setActiveArtifactItem] = useState<ArtifactItem | null>(null);
  const [artifactVersion, setArtifactVersion] = useState<number>(1);
  const [artifactTab, setArtifactTab] = useState<'preview' | 'code' | 'diff'>('preview');
  const [artifactPanelWidth, setArtifactPanelWidth] = useState<number>(580);
  const [isArtFullscreen, setIsArtFullscreen] = useState<boolean>(false);

  const [toolsOpen, setToolsOpen] = useState<boolean>(true);
  const [promptInput, setPromptInput] = useState<string>('');
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Real runtime state (no mock data)
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [ptyStatus, setPtyStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'terminated'>('disconnected');
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [skills, setSkills] = useState<SkillBundle[]>([]);
  const [lastPromptEnvelope, setLastPromptEnvelope] = useState<PromptEnvelope | null>(null);
  const [memoryState, setMemoryState] = useState<SharedMemoryState>(EMPTY_MEMORY_STATE);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);

  const ptyClientRef = useRef<PtyClient | null>(null);
  const ndjsonBufferRef = useRef<string>('');
  const currentAsstMsgIdRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(activeThreadId);
  const selectedAgentRef = useRef<AgentId>(selectedAgent);
  const conversationIdRef = useRef<string | null>(null);
  const touchedFilesRef = useRef<Set<string>>(new Set());

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizerRef = useRef<HTMLDivElement | null>(null);
  const isResizingRef = useRef<boolean>(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(580);

  useEffect(() => {
    activeThreadIdRef.current = activeThreadId;
  }, [activeThreadId]);

  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  const stateRef = useRef<ChorusAppState>({
    threads,
    activeThreadId,
    currentView: (currentView === 'chat' && mode === 'terminal' ? 'terminal' : currentView) as any,
    ptyStatus,
    autonomousMode,
    artifactPanelVisible: Boolean(activeArtifactItem),
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

  useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);

  useEffect(() => {
    stateRef.current = {
      threads,
      activeThreadId,
      currentView: (currentView === 'chat' && mode === 'terminal' ? 'terminal' : currentView) as any,
      ptyStatus,
      autonomousMode,
      artifactPanelVisible: Boolean(activeArtifactItem),
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

  /* ---------- Artifact Registration Helper ---------- */
  const registerArtifact = async (filePath: string, content?: string, threadIdOverride?: string) => {
    const tId = threadIdOverride || activeThreadIdRef.current || 'thread-1';
    const agent = selectedAgentRef.current;
    try {
      const res = await fetch('/api/artifacts/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath,
          content,
          agent,
          threadId: tId,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const fileName = data.name || filePath.split('/').pop() || filePath;
        const item: ArtifactItem = {
          id: `art-${fileName}`,
          threadId: tId,
          agent,
          path: data.path || filePath,
          name: fileName,
          version: 1,
          content: data.content ?? content ?? '',
          createdAt: 'Just now',
        };
        setArtifacts(prev => {
          const exists = prev.some(a => a.name === item.name);
          if (exists) {
            return prev.map(a => (a.name === item.name ? item : a));
          }
          return [item, ...prev];
        });
        setActiveArtifactItem(item);
        setMessages(prev =>
          prev.map(m =>
            m.id === currentAsstMsgIdRef.current
              ? { ...m, artifactRef: { name: item.name, path: item.path, version: 1 } }
              : m,
          ),
        );
        setMemoryState(prev => {
          const filtered = prev.workingMemory.filter(w => w.key !== `artifact:${item.name}`);
          return {
            ...prev,
            workingMemory: [
              {
                key: `artifact:${item.name}`,
                value: item.path,
                updatedBy: agent,
                updatedAt: 'Just now',
                readBy: [agent],
              },
              ...filtered,
            ],
          };
        });
        window.__CHORUS_HARNESS__?.emit('artifact:updated', item);
      }
    } catch (e) {
      console.error('Failed to register artifact:', e);
    }
  };

  /* ---------- Stream-JSON Line Parser for Real AGY CLI ---------- */
  const handleStreamJsonLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return false;

    try {
      const parsed = JSON.parse(trimmed);
      const agent = selectedAgentRef.current;

      if (parsed.event === 'user') {
        return true;
      }

      if (parsed.event === 'init') {
        conversationIdRef.current = parsed.conversation_id || null;
        const modelUsed = parsed.init?.model || modelsState[agent];
        setTerminalLogs(prev => [
          ...prev,
          `\r\n\x1b[36m[agy:init]\x1b[0m conversation=${parsed.conversation_id} model=${modelUsed}\r\n`,
        ]);
        setActivityEvents(prev => [
          {
            id: `ev-init-${Date.now()}`,
            timestamp: new Date().toLocaleTimeString(),
            type: 'bridge',
            agent,
            summary: `CLI initialized (${modelUsed})`,
            meta: parsed.init || parsed,
          },
          ...prev,
        ]);
        return true;
      }

      if (parsed.event === 'step_update' && parsed.step_update) {
        const su = parsed.step_update;

        if (su.step_type === 'tool') {
          const toolName = su.tool_name || su.tool_info?.name || 'tool';
          const params = su.tool_info?.parameters || {};
          const target =
            params.AbsolutePath ||
            params.TargetFile ||
            params.DirectoryPath ||
            params.CommandLine ||
            params.SearchPath ||
            params.Query ||
            params.Url ||
            JSON.stringify(params);
          const output = su.tool_info?.output || '';
          const status: ToolCallSummary['status'] = su.state === 'ACTIVE' ? 'running' : 'ok';

          setTerminalLogs(prev => [
            ...prev,
            `\r\n\x1b[33m[agy:tool]\x1b[0m ${toolName} (${su.state}) ${target}${output ? ` -> ${output}` : ''}\r\n`,
          ]);

          const toolSummary: ToolCallSummary = {
            id: `step-${su.step_index}`,
            verb: toolName,
            target: String(target),
            status,
            detail: JSON.stringify(params, null, 2),
            stdout: output,
          };

          // Update chat screen message toolCalls
          setMessages(prev =>
            prev.map(m => {
              if (m.id !== currentAsstMsgIdRef.current) return m;
              const existing = m.toolCalls || [];
              const idx = existing.findIndex(tc => tc.id === toolSummary.id);
              const nextCalls =
                idx >= 0
                  ? existing.map((tc, i) => (i === idx ? toolSummary : tc))
                  : [...existing, toolSummary];
              return { ...m, toolCalls: nextCalls };
            }),
          );

          // Update Shared Memory with real tool execution data
          const filePathCandidate = params.AbsolutePath || params.TargetFile || params.DirectoryPath;
          if (filePathCandidate && typeof filePathCandidate === 'string') {
            touchedFilesRef.current.add(filePathCandidate);
          }

          setMemoryState(prev => {
            const toolKey = `tool:${toolName}`;
            const toolVal = JSON.stringify({
              tool: toolName,
              target,
              parameters: params,
              output: output || (su.state === 'ACTIVE' ? 'running' : 'completed'),
              state: su.state,
            });

            const touchedArr = Array.from(touchedFilesRef.current);
            const otherEntries = prev.workingMemory.filter(
              w => w.key !== toolKey && w.key !== 'touched_files',
            );

            const nextWorking = [
              {
                key: toolKey,
                value: toolVal,
                updatedBy: agent,
                updatedAt: 'Just now',
                readBy: [agent],
              },
              ...(touchedArr.length > 0
                ? [
                    {
                      key: 'touched_files',
                      value: JSON.stringify(touchedArr),
                      updatedBy: agent,
                      updatedAt: 'Just now',
                      readBy: [agent],
                    },
                  ]
                : []),
              ...otherEntries,
            ];

            return {
              ...prev,
              workingMemory: nextWorking,
              ringBufferUsed: prev.ringBufferUsed + 1,
            };
          });

          if (su.state === 'DONE') {
            setActivityEvents(prev => [
              {
                id: `ev-tool-${su.step_index}-${Date.now()}`,
                timestamp: new Date().toLocaleTimeString(),
                type: 'workspace',
                agent,
                summary: `${toolName}: ${target}`,
                meta: su.tool_info || su,
                durationMs: su.duration_seconds ? Math.round(su.duration_seconds * 1000) : undefined,
              },
              ...prev,
            ]);

            // Check if this tool created/modified an artifact or HTML/MD/SVG file
            const writtenFile = params.TargetFile || params.AbsolutePath || '';
            if (
              toolName === 'write_to_file' ||
              toolName === 'replace_file_content' ||
              (typeof writtenFile === 'string' &&
                (writtenFile.endsWith('.html') ||
                  writtenFile.endsWith('.svg') ||
                  writtenFile.endsWith('.md')))
            ) {
              if (writtenFile) {
                registerArtifact(
                  writtenFile,
                  params.CodeContent || params.ReplacementContent,
                );
              }
            } else if (toolName === 'run_command' && typeof params.CommandLine === 'string') {
              const htmlMatch = params.CommandLine.match(/([a-zA-Z0-9_.\-/]+\.html)/);
              if (htmlMatch) {
                registerArtifact(htmlMatch[1]);
              }
            }
          }

          return true;
        }

        if (su.step_type === 'agent_response') {
          if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
            setTerminalLogs(prev => [...prev, su.text_delta]);
            setMessages(prev =>
              prev.map(m =>
                m.id === currentAsstMsgIdRef.current
                  ? { ...m, content: (m.content || '') + su.text_delta }
                  : m,
              ),
            );
          }

          if (su.usage?.total_tokens) {
            setMemoryState(prev => ({
              ...prev,
              budgetUsedTokens: su.usage.total_tokens,
            }));
          }
          return true;
        }

        return true;
      }

      if (parsed.event === 'result' && parsed.result) {
        const res = parsed.result;
        if (typeof res.response === 'string' && res.response.length > 0) {
          setMessages(prev =>
            prev.map(m => {
              if (m.id !== currentAsstMsgIdRef.current) return m;
              if (!m.content || m.content.trim().length === 0) {
                setTerminalLogs(logs => [...logs, `${res.response}\r\n`]);
                return { ...m, content: res.response };
              }
              return m;
            }),
          );
        }
        if (res.usage?.total_tokens) {
          setMemoryState(prev => ({
            ...prev,
            budgetUsedTokens: res.usage.total_tokens,
          }));
        }
        setAgentRunning(false);
        window.__CHORUS_HARNESS__?.emit('turn:completed', res);
        return true;
      }
    } catch {
      // Not valid JSON or partial line
    }
    return false;
  };

  /* ---------- PTY Execution Spawner ---------- */
  const spawnPtySession = async (options: PtySpawnOptions) => {
    if (ptyClientRef.current) {
      ptyClientRef.current.destroy();
    }
    const client = new PtyClient();
    ptyClientRef.current = client;
    ndjsonBufferRef.current = '';
    setPtyStatus('connecting');
    stateRef.current = { ...stateRef.current, ptyStatus: 'connecting' };

    client.onData(data => {
      window.__CHORUS_HARNESS__?.emit('pty:data', data);

      ndjsonBufferRef.current += data;
      const lines = ndjsonBufferRef.current.split('\n');
      ndjsonBufferRef.current = lines.pop() || '';

      for (const line of lines) {
        const handledJson = handleStreamJsonLine(line);
        if (!handledJson) {
          setTerminalLogs(prev => [...prev, line + '\r\n']);
          const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
          if (clean.trim()) {
            setMessages(prev =>
              prev.map(m =>
                m.id === currentAsstMsgIdRef.current
                  ? { ...m, content: m.content ? `${m.content}\n${clean}` : clean }
                  : m,
              ),
            );
          }
        }
      }
    });

    client.onExit(code => {
      if (ndjsonBufferRef.current.trim()) {
        const leftover = ndjsonBufferRef.current;
        ndjsonBufferRef.current = '';
        if (!handleStreamJsonLine(leftover)) {
          setTerminalLogs(prev => [...prev, leftover + '\r\n']);
        }
      }
      setPtyStatus('terminated');
      stateRef.current = { ...stateRef.current, ptyStatus: 'terminated' };
      setAgentRunning(false);
      window.__CHORUS_HARNESS__?.emit('pty:exit', code);
    });

    try {
      await client.spawn(options);
      if (client.destroyed) return;
      setPtyStatus('connected');
      stateRef.current = { ...stateRef.current, ptyStatus: 'connected' };
    } catch (err) {
      if (client.destroyed) return;
      setPtyStatus('terminated');
      stateRef.current = { ...stateRef.current, ptyStatus: 'terminated' };
      setAgentRunning(false);
      console.error('PTY spawn failed:', err);
    }
  };

  const spawnPromiseRef = useRef<Promise<PtyClient | null> | null>(null);

  const ensureRealCliSession = async (agent: AgentId): Promise<PtyClient | null> => {
    if (
      ptyClientRef.current &&
      !ptyClientRef.current.destroyed &&
      stateRef.current.ptyStatus === 'connected'
    ) {
      return ptyClientRef.current;
    }
    if (spawnPromiseRef.current && ptyClientRef.current && !ptyClientRef.current.destroyed) {
      return spawnPromiseRef.current;
    }

    const promise = (async () => {
      const modelId = modelsState[agent];
      const cliCmd = AGENTS_CONFIG[agent].cli;

      if (agent === 'agy') {
        const args = [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
          '--model',
          modelId || 'gemini-3.8-flash-low',
          '-p=',
        ];
        await spawnPtySession({
          id: `agy-${Date.now()}`,
          command: cliCmd,
          args,
        });
      } else {
        await spawnPtySession({
          id: `${agent}-${Date.now()}`,
          command: cliCmd,
          args: [],
        });
      }

      spawnPromiseRef.current = null;
      return ptyClientRef.current && !ptyClientRef.current.destroyed
        ? ptyClientRef.current
        : null;
    })();

    spawnPromiseRef.current = promise;
    return promise;
  };

  /* ---------- Pre-warm real AGY session & initial thread on mount ---------- */
  useEffect(() => {
    const initialThreadId = `thread-${Date.now()}`;
    const initialThread: Thread = {
      id: initialThreadId,
      title: 'New chat',
      agent: 'agy',
      model: 'Gemini 3.8 Flash (Low)',
      autonomous: true,
      createdAt: 'Just now',
      updatedAt: 'Just now',
    };
    setThreads([initialThread]);
    setActiveThreadId(initialThreadId);
    activeThreadIdRef.current = initialThreadId;

    // Pre-spawn real agy CLI session so MCP initialization begins immediately
    ensureRealCliSession('agy');

    return () => {
      ptyClientRef.current?.destroy();
      ptyClientRef.current = null;
      spawnPromiseRef.current = null;
    };
  }, []);

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
            id: `art-${art.name}`,
            threadId: art.threadId || activeThreadIdRef.current || 'thread-1',
            agent: art.agent || selectedAgentRef.current,
            path: art.path,
            name: art.name,
            version: art.version || 1,
            content: art.content,
            createdAt: 'Just now',
          };
          setArtifacts(prev => {
            const exists = prev.some(a => a.name === item.name);
            return exists ? prev.map(a => (a.name === item.name ? item : a)) : [item, ...prev];
          });
          setActiveArtifactItem(item);
          window.__CHORUS_HARNESS__?.emit('artifact:updated', item);
        } catch {}
      });
    } catch {}
    return () => es?.close();
  }, []);

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
            setActiveArtifactItem(null);
          }
        },
        setActiveArtifact: a => {
          setActiveArtifactItem(a);
          if (a) {
            setArtifacts(prev => (prev.some(x => x.name === a.name) ? prev : [a, ...prev]));
          }
        },
        setActiveArtifactVersion: v => setArtifactVersion(v),
        setPendingApprovals: apps => setPendingApprovals(apps),
        setSkills: sks => setSkills(sks),
        selectAgentModel: (agent, model) => {
          setSelectedAgent(agent);
          setSelectedModel(model);
        },
        triggerMidSessionHandoff: async (targetAgent: AgentId) => {
          setSelectedAgent(targetAgent);
        },
        simulateFileDrop: async () => {},
        getPtyClient: () => ptyClientRef.current,
        spawnPty: spawnPtySession,
        setPromptEnvelope: envelope => setLastPromptEnvelope(envelope),
        setMemoryState: mem => setMemoryState(mem),
        addActivityEvent: ev => setActivityEvents(prev => [ev, ...prev]),
      },
    );

    window.__CHORUS_HARNESS__ = harness;
  }, []);

  /* ---------- Handlers ---------- */
  const handleSyncSkills = async () => {
    showToast('Scanning .agents/skills, .claude/skills, and .codex/skills...');
    try {
      const res = await fetch('/api/skills/scan', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        const found: SkillBundle[] = data.skills || [];
        setSkills(found);
        stateRef.current = { ...stateRef.current, skills: found };
        showToast(`Scanned skill folders · ${found.length} skill(s) loaded`);
        window.__CHORUS_HARNESS__?.emit('skills:scanned', data);
      }
    } catch {}
  };

  const handleToggleSkill = async (skillId: string, active: boolean) => {
    const currentSkill = stateRef.current.skills.find(s => s.id === skillId);
    const content = currentSkill?.content || `# ${skillId}`;

    const updated = stateRef.current.skills.map(s =>
      s.id === skillId ? { ...s, active } : s,
    );
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

  const handleComposerSubmit = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    const val = promptInput.trim();
    if (!val) return;

    let threadId = activeThreadId;
    if (!threadId) {
      threadId = `thread-${Date.now()}`;
      const newThread: Thread = {
        id: threadId,
        title: val.slice(0, 40),
        agent: selectedAgent,
        model: selectedModel,
        autonomous: autonomousMode,
        createdAt: 'Just now',
        updatedAt: 'Just now',
      };
      setThreads(prev => [newThread, ...prev]);
      setActiveThreadId(threadId);
      activeThreadIdRef.current = threadId;
    } else {
      setThreads(prev =>
        prev.map(t =>
          t.id === threadId && (t.title === 'New chat' || t.title === 'New Chat')
            ? { ...t, title: val.slice(0, 40), updatedAt: 'Just now' }
            : t,
        ),
      );
    }

    if (screen === 'home') {
      setScreen('thread');
    }

    const envelope: PromptEnvelope = {
      turn_id: `turn-${Date.now()}`,
      target_engine: selectedAgent,
      user_prompt: val,
      context_files: [],
      context_artifacts: [],
      on_demand_skills: [],
      shared_memory_budget_tokens: 4000,
    };

    setLastPromptEnvelope(envelope);
    stateRef.current = { ...stateRef.current, lastPromptEnvelope: envelope };

    // Record active_goal in Shared Memory
    setMemoryState(prev => {
      const others = prev.workingMemory.filter(w => w.key !== 'active_goal');
      return {
        ...prev,
        workingMemory: [
          {
            key: 'active_goal',
            value: val,
            updatedBy: selectedAgent,
            updatedAt: 'Just now',
            readBy: [selectedAgent],
          },
          ...others,
        ],
        ringBufferUsed: prev.ringBufferUsed + 1,
      };
    });

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      threadId,
      role: 'user',
      content: val,
      timestamp: 'Just now',
    };

    const asstMsgId = `asst-${Date.now() + 1}`;
    currentAsstMsgIdRef.current = asstMsgId;

    const asstMsg: ChatMessage = {
      id: asstMsgId,
      threadId,
      role: 'assistant',
      agent: selectedAgent,
      model: selectedModel,
      content: '',
      toolCalls: [],
      timestamp: 'Just now',
    };

    setMessages(prev => [...prev, userMsg, asstMsg]);
    setTerminalLogs(prev => [...prev, `\r\n\x1b[35m> ${val}\x1b[0m\r\n`]);
    setPromptInput('');
    setAgentRunning(true);

    const client = await ensureRealCliSession(selectedAgent);
    if (client) {
      if (selectedAgent === 'agy') {
        const payload = JSON.stringify({
          event: 'user',
          message: { content: val },
        });
        await client.write(payload + '\n');
      } else {
        await client.write(val + '\n');
      }
    }
  };

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleComposerSubmit();
    }
  };

  const handleNewChat = () => {
    const newId = `thread-${Date.now()}`;
    const newThread: Thread = {
      id: newId,
      title: 'New chat',
      agent: selectedAgent,
      model: selectedModel,
      autonomous: autonomousMode,
      createdAt: 'Just now',
      updatedAt: 'Just now',
    };
    setThreads(prev => [newThread, ...prev]);
    setActiveThreadId(newId);
    activeThreadIdRef.current = newId;
    setCurrentView('chat');
    setScreen('thread');
    setMode('chat');
    ensureRealCliSession(selectedAgent);
  };

  const artifactPanelVisible = Boolean(activeArtifactItem);
  const currentThreadMessages = messages.filter(m => m.threadId === activeThreadId);

  return (
    <>
      <section className="window" id="window" aria-label="Chorus app window" data-theme={theme}>
        <div
          className={`app ${artifactPanelVisible ? '' : 'art-collapsed'} ${
            isArtFullscreen ? 'art-full' : ''
          }`}
        >
          {/* Left Sidebar */}
          <aside className="sidebar" data-test="app-sidebar">
            <div className="sb-head">
              <span className="wordmark">
                <span className="glyph" aria-hidden="true">
                  <b />
                  <b />
                  <b />
                </span>
                Chorus
              </span>
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
              className={`nav ${currentView === 'chat' && mode === 'chat' ? 'on' : ''}`}
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

            {/* Artifacts Section in Sidebar */}
            <div className="sb-label">Artifacts</div>
            <div className="recents" data-test="sidebar-artifacts">
              {artifacts.length === 0 ? (
                <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--muted)' }}>
                  No artifacts yet
                </div>
              ) : (
                artifacts.map(art => (
                  <button
                    key={art.id}
                    type="button"
                    className={`recent ${activeArtifactItem?.name === art.name ? 'on' : ''}`}
                    data-test={`sidebar-artifact-${art.name}`}
                    onClick={() => {
                      setActiveArtifactItem(art);
                      setArtifactTab('preview');
                    }}
                  >
                    <span>{art.name}</span>
                    <span className={`mark xs m-${art.agent}`}>{art.agent[0].toUpperCase()}</span>
                  </button>
                ))
              )}
            </div>

            <div className="sb-label">Recent chats</div>
            <div className="recents" data-test="sidebar-threads">
              {threads.map(t => (
                <button
                  key={t.id}
                  type="button"
                  className={`recent ${
                    t.id === activeThreadId && currentView === 'chat' ? 'on' : ''
                  }`}
                  onClick={() => {
                    setActiveThreadId(t.id);
                    activeThreadIdRef.current = t.id;
                    setCurrentView('chat');
                    setScreen('thread');
                  }}
                  data-test={`thread-item-${t.id}`}
                >
                  <span>{t.title}</span>
                  <span className={`mark xs m-${t.agent}`}>{t.agent[0].toUpperCase()}</span>
                </button>
              ))}
            </div>

            <div className="sb-foot">
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
                data-test="toggle-skip-permissions"
                onClick={() => setAutonomousMode(!autonomousMode)}
                title="Toggle autonomous permissions bypass"
              >
                <strong>{threads.find(t => t.id === activeThreadId)?.title || 'New chat'}</strong>
                <span className="sub">· chorus</span>
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
              </button>

              <div className="top-right">
                {currentView === 'chat' && (
                  <div className="seg" role="group" aria-label="View switch">
                    <button
                      type="button"
                      data-test="nav-chat-mode"
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
                  toolCalls: activityEvents.filter(e => e.type === 'workspace').length,
                  approvals: pendingApprovals.length,
                  handoffs: 0,
                }}
              />
            ) : mode === 'terminal' ? (
              <TerminalView
                ptyClient={ptyClientRef.current}
                agentName={selectedAgent}
                modelName={selectedModel}
                status={ptyStatus}
                logs={terminalLogs}
              />
            ) : (
              <div className="thread" id="thread" data-test="chat-timeline">
                <div className="thread-inner">
                  {currentThreadMessages.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
                      <span className={`mark m-${selectedAgent} lg`} style={{ margin: '0 auto 12px' }}>
                        {selectedAgent[0].toUpperCase()}
                      </span>
                      <h3 style={{ margin: '0 0 6px', color: 'var(--ink)' }}>
                        {AGENTS_CONFIG[selectedAgent].name}
                      </h3>
                      <p style={{ margin: '0 0 20px', fontSize: 13.5 }}>
                        Model: <strong>{selectedModel}</strong> · CLI: <code>{AGENTS_CONFIG[selectedAgent].cli}</code>
                      </p>
                    </div>
                  ) : (
                    currentThreadMessages.map(m => (
                      <div
                        key={m.id}
                        className={m.role === 'user' ? 'u-msg' : 'a-msg'}
                        data-test={m.role === 'user' ? 'user-message' : 'assistant-message'}
                      >
                        {m.role === 'assistant' && (
                          <div className="by">
                            <span className={`mark xs m-${m.agent || selectedAgent}`}>
                              {(m.agent || selectedAgent)[0].toUpperCase()}
                            </span>
                            <span>{AGENTS_CONFIG[m.agent || selectedAgent].name}</span>
                            <span className="model">{m.model || selectedModel}</span>
                          </div>
                        )}

                        {/* Real Tool Calls captured on Chat Screen */}
                        {m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0 && (
                          <>
                            <button
                              className="tools-sum"
                              type="button"
                              data-test="tool-group-toggle"
                              aria-expanded={toolsOpen}
                              onClick={() => setToolsOpen(!toolsOpen)}
                            >
                              Ran {m.toolCalls.length} tool{m.toolCalls.length === 1 ? '' : 's'}{' '}
                              <Icon name="right" className="sm chev" />
                            </button>

                            {toolsOpen && (
                              <div className="tool-group" data-test="tool-group-list">
                                {m.toolCalls.map(tc => (
                                  <div
                                    key={tc.id}
                                    className="tool"
                                    data-test="chat-tool-call"
                                    data-tool-name={tc.verb}
                                  >
                                    <div className="tool-row">
                                      <Icon name="term" className="sm" />
                                      <span className="verb" data-test="tool-call-name">
                                        {tc.verb}
                                      </span>
                                      <span className="target" data-test="tool-call-target">
                                        {tc.target}
                                      </span>
                                      <span className="meta">
                                        <span className={tc.status === 'ok' ? 'st-ok' : ''}>
                                          {tc.status === 'running' ? 'running...' : 'done'}
                                        </span>
                                      </span>
                                    </div>
                                    {(tc.stdout || tc.detail) && (
                                      <div className="tool-detail" data-test="tool-call-output">
                                        <div className="out">{tc.stdout || tc.detail}</div>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}

                        <p
                          data-test={m.role === 'assistant' ? 'assistant-text' : 'user-text'}
                          style={{ whiteSpace: 'pre-wrap', margin: 0 }}
                        >
                          {m.content || (m.role === 'assistant' && agentRunning ? 'Running...' : '')}
                        </p>

                        {m.role === 'assistant' && m.artifactRef && (
                          <button
                            className="art"
                            type="button"
                            data-test="chat-artifact-card"
                            onClick={() => {
                              const found = artifacts.find(a => a.name === m.artifactRef?.name);
                              if (found) {
                                setActiveArtifactItem(found);
                                setArtifactTab('preview');
                              }
                            }}
                          >
                            <span className="thumb">
                              <Icon name="globe" />
                            </span>
                            <span className="t">
                              <strong>{m.artifactRef.name}</strong>
                              <small>{m.artifactRef.path} · Click to open preview</small>
                            </span>
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Composer Dock */}
            {(currentView === 'chat' || currentView === 'terminal') && (
              <div className="dock">
                <form className="composer" id="composer" onSubmit={handleComposerSubmit}>
                  <label className="sr" htmlFor="prompt">
                    Message
                  </label>
                  <textarea
                    id="prompt"
                    ref={composerTextareaRef}
                    data-test="composer-input"
                    rows={1}
                    value={promptInput}
                    onKeyDown={handleComposerKeyDown}
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
                    placeholder={`Ask ${AGENTS_CONFIG[selectedAgent].name}…`}
                  />

                  <div className="c-row">
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
                      {(['agy', 'claude', 'codex'] as AgentId[]).map(k => {
                        const isCurrent = k === selectedAgent;
                        return (
                          <div key={k}>
                            <button
                              className="mi"
                              type="button"
                              data-test={`agent-opt-${k}`}
                              onClick={() => setMenuAgent(k)}
                            >
                              <span className={`mark m-${k}`}>{k[0].toUpperCase()}</span>
                              <span className="t">
                                <strong>{AGENTS_CONFIG[k].name}</strong>
                                <small>{AGENTS_CONFIG[k].models.length} native models</small>
                              </span>
                              {isCurrent && (
                                <span className="tick">
                                  <Icon name="check" />
                                </span>
                              )}
                            </button>
                            {k === menuAgent && (
                              <div className="models" role="radiogroup">
                                {AGENTS_CONFIG[k].models.map(([id, n, d]) => (
                                  <button
                                    key={id}
                                    className={`model ${selectedAgent === k && selectedModel === n ? 'on' : ''}`}
                                    type="button"
                                    data-test={`model-opt-${id}`}
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
                    </div>
                  )}

                  {handoffMenuOpen && (
                    <HandoffPopover
                      currentAgent={selectedAgent}
                      onSelectAgent={target => {
                        setSelectedAgent(target);
                        setHandoffMenuOpen(false);
                      }}
                      onClose={() => setHandoffMenuOpen(false)}
                    />
                  )}

                  {mentionMenuOpen && (
                    <MentionPopover
                      query=""
                      artifacts={artifacts.map(a => ({ name: a.name, path: a.path }))}
                      onSelect={(item: MentionItem) => {
                        setPromptInput(prev => `${prev}@${item.path} `);
                        setMentionMenuOpen(false);
                      }}
                      onClose={() => setMentionMenuOpen(false)}
                    />
                  )}

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
          {artifactPanelVisible && activeArtifactItem && (
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
                  <strong data-test="artifact-title">{activeArtifactItem.name}</strong>
                  <small data-test="artifact-meta">
                    {activeArtifactItem.path} · v{activeArtifactItem.version} · live ·{' '}
                    {isArtFullscreen ? 'fullscreen' : `${artifactPanelWidth}px`}
                  </small>
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
                    setActiveArtifactItem(null);
                  }}
                >
                  <Icon name="x" />
                </button>
              </div>

              <div className="p-body" data-test="artifact-body">
                {artifactTab === 'preview' ? (
                  <iframe
                    data-test="artifact-iframe"
                    title={activeArtifactItem.name}
                    srcDoc={activeArtifactItem.content}
                    style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
                  />
                ) : artifactTab === 'code' ? (
                  <pre className="src" data-test="artifact-source">
                    {activeArtifactItem.content}
                  </pre>
                ) : (
                  <div className="diff-view" data-test="artifact-diff">
                    <div className="head-line">+++ {activeArtifactItem.path}</div>
                    <div className="add-line">{activeArtifactItem.content}</div>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>

      {toastMsg && (
        <div className="toast" data-test="toast-notification">
          {toastMsg}
        </div>
      )}
    </>
  );
}

export default App;

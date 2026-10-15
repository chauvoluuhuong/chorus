export type AgentId = 'claude' | 'agy' | 'codex';

export interface AgentInfo {
  id: AgentId;
  name: string;
  badge: string;
  cliCommand: string;
  defaultModel: string;
  models: { id: string; name: string; desc: string; quota?: string; installed?: boolean }[];
}

export interface Thread {
  id: string;
  title: string;
  agent: AgentId;
  model: string;
  autonomous: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'handoff';
  content: string;
  agent?: AgentId;
  model?: string;
  timestamp: string;
  toolCalls?: ToolCallSummary[];
  approvalRequest?: ApprovalRequest;
  artifactRef?: { name: string; path: string; version: number };
}

export interface ToolCallSummary {
  id: string;
  verb: string;
  target: string;
  status: 'running' | 'ok' | 'denied' | 'waiting';
  detail?: string;
  diff?: string;
  stdout?: string;
  autoApproved?: boolean;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  toolCallId: string;
  command: string;
  summary: string;
  risk: string;
  status: 'pending' | 'allowed' | 'denied';
  timestamp: string;
}

export interface ArtifactItem {
  id: string;
  threadId: string;
  agent: AgentId;
  path: string;
  name: string;
  version: number;
  content: string;
  diff?: string;
  createdAt: string;
}

export interface SkillBundle {
  id: string;
  name: string;
  command: string;
  description: string;
  path: string;
  active: boolean;
  origin: string;
  content?: string;
}

export interface PromptEnvelope {
  turn_id: string;
  target_engine: AgentId;
  user_prompt: string;
  context_files: string[];
  context_artifacts: string[];
  on_demand_skills: string[];
  shared_memory_budget_tokens: number;
}

export interface ChorusAppState {
  threads: Thread[];
  activeThreadId: string | null;
  currentView: 'chat' | 'terminal' | 'skills' | 'memory' | 'activity';
  ptyStatus: 'disconnected' | 'connecting' | 'connected' | 'terminated';
  autonomousMode: boolean;
  artifactPanelVisible: boolean;
  artifactPanelWidth: number;
  activeArtifact: ArtifactItem | null;
  activeArtifactVersion: number;
  pendingApprovals: ApprovalRequest[];
  skills: SkillBundle[];
  selectedAgent: AgentId;
  selectedModel: string;
  lastPromptEnvelope: PromptEnvelope | null;
}

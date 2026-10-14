# Technical Specification: Context Ledger & Storage Adapter — Chorus

> [!NOTE]
> **Working Proposal**: The data schemas, trait signatures, and tool definitions in this document serve as detailed technical reference drafts and are subject to change during active implementation.

---

## 1. Document Database Choice: PoloDB

Chorus adopts [PoloDB](https://www.polodb.org/) as its embedded document database engine:
* **Embedded & In-Process**: Compiles directly into the Rust backend (Tauri) with zero external setup, daemons, or ports.
* **MongoDB-Compatible API**: Operates on native BSON/JSON collections (`db.collection("turns").find(...)`).
* **Single File Footprint**: All collections reside in a single file on disk (`~/.chorus/ledger.polodb`).

---

## 2. Document Data Schemas (PoloDB Collections)

### 2.1 Collection: `turns`
Tracks user prompts, intent, and high-level agent outcomes.

```json
{
  "_id": "turn_1048",
  "agent_id": "claude",
  "started_at": "2026-10-14T10:15:00Z",
  "completed_at": "2026-10-14T10:15:35Z",
  "user_intent": {
    "raw_prompt": "Extract verifyJwt from auth.ts and run tests",
    "summary": "Refactor auth verification & run test suite"
  },
  "handoff_summary": {
    "outcome": "Extracted verifyJwt helper into src/auth.ts. Tests passing.",
    "files_touched": ["src/auth.ts", "test/auth.test.ts"],
    "verification": { "tests_passed": 12, "tests_failed": 0 },
    "open_milestones": ["Add token revocation cache"]
  },
  "execution_ids": ["exec_901", "exec_902"],
  "artifact_ids": ["art_301"]
}
```

### 2.2 Collection: `executions`
Stores structured tool invocations, arguments, and execution telemetry.

```json
{
  "_id": "exec_902",
  "turn_id": "turn_1048",
  "agent_id": "claude",
  "tool_name": "run_command",
  "arguments": {
    "CommandLine": "npm test"
  },
  "status": "success",
  "exit_code": 0,
  "stdout_preview": "PASS test/auth.test.ts (12 tests passed)",
  "raw_log_path": "~/.chorus/logs/exec_902.log",
  "executed_at": "2026-10-14T10:15:20Z"
}
```

### 2.3 Collection: `artifacts`
Registers all generated code files, HTML mockups, SVGs, and markdown documentation.

```json
{
  "_id": "art_301",
  "turn_id": "turn_1048",
  "agent_id": "claude",
  "artifact_type": "html_preview",
  "title": "Auth Modal UI Mockup",
  "file_path": "documents/ui-mockup.html",
  "file_size_bytes": 31337,
  "summary": "Tailwind + Alpine.js interactive login card",
  "created_at": "2026-10-14T10:15:30Z"
}
```

---

## 3. Storage Adapter Trait (Rust Draft)

```rust
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[async_trait]
pub trait StorageAdapter: Send + Sync {
    // Turns
    async fn save_turn(&self, turn: &TurnDoc) -> Result<(), StorageError>;
    async fn get_turn(&self, turn_id: &str) -> Result<Option<TurnDoc>, StorageError>;
    async fn get_latest_turn(&self, agent_id: Option<&str>) -> Result<Option<TurnDoc>, StorageError>;

    // Executions
    async fn record_execution(&self, exec: &ToolExecutionDoc) -> Result<(), StorageError>;
    async fn get_execution(&self, exec_id: &str) -> Result<Option<ToolExecutionDoc>, StorageError>;
    async fn list_executions(&self, filter: ExecutionFilter) -> Result<Vec<ToolExecutionDoc>, StorageError>;

    // Artifacts
    async fn register_artifact(&self, artifact: &ArtifactDoc) -> Result<(), StorageError>;
    async fn get_artifact(&self, artifact_id: &str) -> Result<Option<ArtifactDoc>, StorageError>;
    async fn list_artifacts(&self, filter: ArtifactFilter) -> Result<Vec<ArtifactDoc>, StorageError>;
}
```

---

## 4. MCP Server Tool Signatures (`agent-bridge-mcp`)

```typescript
// Telemetry & Execution Tools
interface ListAgentActivitiesParams {
  agent?: 'agy' | 'claude' | 'codex';
  status?: 'success' | 'failed' | 'pending';
  limit?: number;
}

interface GetToolExecutionParams {
  exec_id: string;
  offset?: 'head' | 'tail';
  lines?: number;
}

// Artifact Discovery & Retrieval
interface ListPeerArtifactsParams {
  agent?: 'agy' | 'claude' | 'codex';
  type?: 'code' | 'html_preview' | 'markdown' | 'svg';
}

interface GetArtifactContentParams {
  artifact_id: string;
  start_line?: number;
  end_line?: number;
}

// Inter-Agent Messaging
interface AskPeerAgentParams {
  target_agent: 'agy' | 'claude' | 'codex';
  question: string;
}
```

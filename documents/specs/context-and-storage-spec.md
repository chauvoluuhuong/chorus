# Technical Specification: Context Ledger & Storage Adapter — Chorus

> [!NOTE]
> **Working Proposal**: The data schemas, trait signatures, and tool definitions in this document serve as detailed technical reference drafts and are subject to change during active implementation.

---

## 1. Storage Architecture: Decoupled Adapter Pattern with `redb` Default

Chorus avoids the complexity of relational databases (no SQL schemas, joins, or table migrations) and eliminates external `.log` file clutter on disk. Instead, Chorus relies on the **Storage Adapter Pattern**:
* **Default Engine (`redb`)**: An embedded, pure-Rust Key-Value store (`~/.chorus/chorus.redb`). Stores serialized JSON documents directly, has zero runtime dependencies, is crash-safe, and includes a native `compact()` API to shrink file size after pruning.
* **High-Level Contract**: The application layer interacts with a clean document / key-value interface (`turns`, `executions`, `artifacts`, `skills`).
* **Database Agnostic**: The `StorageAdapter` trait decouples application logic. Swapping to alternative engines (e.g. SurrealDB or other KV stores) only requires implementing low-level indexing and compaction without modifying business logic.
* **Single Store Footprint**: All state (chat history, turn summaries, and tool execution outputs) is stored directly in the single database file without maintaining separate `.log` files on disk.

---

## 2. Document Data Schemas

### 2.1 Collection / Bucket: `turns`
Tracks user prompts, intent, and high-level agent outcomes (permanently preserved, never pruned).

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

### 2.2 Collection / Bucket: `executions` (Ring Buffer Managed)
Stores structured tool invocations, arguments, and full execution output directly in the database (no external `.log` files).

To prevent unlimited disk growth, `executions` is managed as a **Ring Buffer**:
* **Configurable Cap**: User-selectable storage cap (default: **1 GB**).
* **Purge Threshold**: When total tool execution data reaches the cap, Chorus prompts the user to purge the oldest tool results (default chunk: **10%–20% of cap**, e.g., 100 MB–200 MB, configurable down to 50 MB) or auto-cleans if enabled.
* **Guaranteed Thread Safety**: Purging only removes heavy tool results (`output`). **Chat threads, messages, turn summaries, and artifacts are ALWAYS preserved.**
* **Pruned Reference Handling**:
  * In the database, the record is marked `status: "pruned"`, `output: null`, and `summary: "Output removed to free space"`.
  * **UI**: Tool rows in chat and activity views display a dimmed badge: *"Output removed to free space"*.
  * **MCP Bridge**: When an agent queries a pruned execution via `get_tool_execution`, the MCP server gracefully returns `{"status": "removed", "message": "Detailed output was pruned to respect storage cap."}`.

```json
// Active execution record
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
  "output": "PASS test/auth.test.ts (12 tests passed)\n...",
  "output_size_bytes": 48200,
  "executed_at": "2026-10-14T10:15:20Z"
}

// Pruned execution record (after Ring Buffer purge)
{
  "_id": "exec_902",
  "turn_id": "turn_1048",
  "agent_id": "claude",
  "tool_name": "run_command",
  "arguments": {
    "CommandLine": "npm test"
  },
  "status": "pruned",
  "exit_code": 0,
  "output": null,
  "summary": "Output removed to free space",
  "executed_at": "2026-10-14T10:15:20Z"
}
```

### 2.3 Collection: `artifacts`
Registers all generated code previews, HTML mockups, SVGs, and markdown documentation.

#### Artifact Filesystem Hierarchy
Artifacts that do not directly belong to the production repository codebase are stored under an isolated, thread-safe hierarchy:

```text
.chorus/artifacts/
└── <ai_cli>/                     (e.g., claude, codex, agy)
    └── <chat_thread_id>/         (e.g., t_order_cake, t_auth_flow)
        ├── order-flow.html
        ├── design-spec.md
        └── architecture.svg
```

**Benefits**:
1. **Multi-Agent Isolation**: Multiple agents working across different turns cannot overwrite each other's preview files.
2. **Thread Scoping**: Artifacts are strictly scoped to their conversation thread.
3. **Clean Archival & Purge**: Deleting or archiving a chat thread automatically purges its associated folder `.chorus/artifacts/*/<chat_thread_id>/`.
4. **Handoff Provenance**: When switching from Claude to Codex, Codex can easily inspect previous artifacts created by Claude under `.chorus/artifacts/claude/<chat_thread_id>/`.

```json
{
  "_id": "art_301",
  "thread_id": "t_order_cake",
  "turn_id": "turn_1048",
  "agent_id": "claude",
  "artifact_type": "html_preview",
  "title": "Cake Order Flow Preview",
  "file_path": ".chorus/artifacts/claude/t_order_cake/order-flow.html",
  "relative_path": "claude/t_order_cake/order-flow.html",
  "file_size_bytes": 31337,
  "summary": "Tailwind interactive order page",
  "created_at": "2026-10-14T10:15:30Z"
}
```

### 2.4 Collection: `skills` (Self-Contained Skill Bundles with Code Storage)
Stores complete skill packages in the database—including markdown instructions, executable scripts (Python/Bash/Node), and boilerplate templates—with automatic disk materialization for CLI execution.

```json
{
  "_id": "skill_db_migrate",
  "name": "db-migrate",
  "title": "Database Migration Assistant",
  "description": "Rules and safety checks for database migrations with bundled verification scripts",
  "origin": "user_created",
  "entrypoint": "SKILL.md",
  "has_scripts": true,
  "bundle_files": [
    {
      "relative_path": "SKILL.md",
      "file_type": "markdown",
      "is_executable": false,
      "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "content": "# Database Migration Guidelines\nRun `python3 scripts/check.py` before executing migrations..."
    },
    {
      "relative_path": "scripts/check.py",
      "file_type": "python",
      "is_executable": true,
      "sha256": "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e",
      "content": "import sys\nimport os\n\ndef check_pending():\n    print('Validating pending migrations...')\n\nif __name__ == '__main__':\n    check_pending()\n"
    },
    {
      "relative_path": "templates/prisma_schema.template",
      "file_type": "template",
      "is_executable": false,
      "sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
      "content": "datasource db {\n  provider = \"postgresql\"\n  url = env(\"DATABASE_URL\")\n}\n"
    }
  ],
  "is_enabled": true,
  "materialized_path": ".agents/skills/db-migrate",
  "created_at": "2026-10-14T11:00:00Z",
  "updated_at": "2026-10-14T11:05:00Z"
}
```

#### 2.4.1 The Materialization & Dematerialization Lifecycle
* **Source of Truth**: The database stores the full skill manifest, executable metadata, and file contents inside `bundle_files`.
* **Materialization (On Enable)**: When a skill is set to `is_enabled: true` (or updated), Chorus writes the full folder structure to disk at `materialized_path`, restoring directory trees and setting executable permissions (`chmod +x`) on files where `is_executable: true`.
* **Dematerialization (On Disable)**: When a skill is set to `is_enabled: false`, Chorus automatically removes its folder from disk (`rm -rf .agents/skills/<name>`) to keep the workspace clean, while preserving all code, scripts, and history inside the database.
* **Deletion**: Permanently removes the record from the database and purges the materialized folder from disk.
* **Creation Modes**:
  1. **UI Skill Studio**: Form entry with optional **AI Refine** assistant to generate script boilerplate and guidelines.
  2. **On-the-Fly Agent Tool**: Agents can invoke `create_project_skill` directly from chat conversation turns.

---

## 3. Storage Adapter Trait (Rust Draft)

The application layer interacts exclusively with the `StorageAdapter` trait. Each concrete database adapter implements low-level indexing, ring buffer eviction, and storage compaction/shrinking.

```rust
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageStats {
    pub total_size_bytes: u64,
    pub tool_executions_bytes: u64,
    pub execution_cap_bytes: u64, // default 1 GB
    pub turns_count: usize,
    pub executions_count: usize,
    pub pruned_executions_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PruneReport {
    pub records_pruned: usize,
    pub bytes_freed: u64,
}

#[async_trait]
pub trait StorageAdapter: Send + Sync {
    // Turns (Permanent)
    async fn save_turn(&self, turn: &TurnDoc) -> Result<(), StorageError>;
    async fn get_turn(&self, turn_id: &str) -> Result<Option<TurnDoc>, StorageError>;
    async fn get_latest_turn(&self, agent_id: Option<&str>) -> Result<Option<TurnDoc>, StorageError>;

    // Executions (Ring Buffer Managed)
    async fn record_execution(&self, exec: &ToolExecutionDoc) -> Result<(), StorageError>;
    async fn get_execution(&self, exec_id: &str) -> Result<Option<ToolExecutionDoc>, StorageError>;
    async fn list_executions(&self, filter: ExecutionFilter) -> Result<Vec<ToolExecutionDoc>, StorageError>;
    async fn prune_oldest_executions(&self, target_bytes_to_free: u64) -> Result<PruneReport, StorageError>;

    // Storage Management & Compaction
    async fn get_storage_stats(&self) -> Result<StorageStats, StorageError>;
    async fn compact(&self) -> Result<(), StorageError>; // Low-level DB shrink/vacuum

    // Artifacts
    async fn register_artifact(&self, artifact: &ArtifactDoc) -> Result<(), StorageError>;
    async fn get_artifact(&self, artifact_id: &str) -> Result<Option<ArtifactDoc>, StorageError>;
    async fn list_artifacts(&self, filter: ArtifactFilter) -> Result<Vec<ArtifactDoc>, StorageError>;

    // Skills
    async fn upsert_skill(&self, skill: &SkillDoc) -> Result<(), StorageError>;
    async fn get_skill(&self, skill_id: &str) -> Result<Option<SkillDoc>, StorageError>;
    async fn list_skills(&self, enabled_only: bool) -> Result<Vec<SkillDoc>, StorageError>;
}
```

---

## 4. MCP Server Tool Signatures (`agent-bridge-mcp`)

```typescript
// Telemetry & Execution Tools
interface ListAgentActivitiesParams {
  agent?: 'agy' | 'claude' | 'codex';
  status?: 'success' | 'failed' | 'pending' | 'pruned';
  limit?: number;
}

interface GetToolExecutionParams {
  exec_id: string;
  offset?: 'head' | 'tail';
  lines?: number;
}

interface GetToolExecutionResult {
  exec_id: string;
  status: 'success' | 'failed' | 'removed';
  output?: string;
  message?: string; // e.g., "Detailed output was pruned to respect storage cap."
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

---

## 5. Artifact Rendering Pipeline (Canvas & Desktop Preview)

Like Antigravity and Claude Desktop, Chorus provides an integrated **Artifact Viewer** so users can immediately view, interact with, and verify files created by agents.

```text
[Agent writes file (e.g., ui-mockup.html)]
                    │
                    ▼
[PostToolUse Hook triggers] ──► Records artifact in database
                    │
                    ▼
[Daemon emits IPC event: `artifact:updated`]
                    │
                    ▼
[Chorus Desktop Canvas / Preview Pane]
┌───────────────────────────────────────────────┐
│ • .html  ──► Sandboxed iframe / WebView       │
│ • .md    ──► GFM Markdown + Mermaid diagrams  │
│ • .svg   ──► Interactive vector viewer        │
│ • code   ──► Monaco editor with diff viewer   │
└───────────────────────────────────────────────┘
```

### 5.1 Real-Time Live Reloading
* When an agent repeatedly calls `replace_file_content` to polish an HTML/CSS file, the desktop app's file-watcher triggers an in-place hot reload in the embedded WebView.
* The user watches the visual UI update in real time without refreshing the desktop application manually.


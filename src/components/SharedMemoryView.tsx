import type { FC } from 'react';
import type { SharedMemoryState } from '../types';

interface SharedMemoryViewProps {
  memoryState: SharedMemoryState;
}

export const SharedMemoryView: FC<SharedMemoryViewProps> = ({ memoryState }) => {
  const {
    workingMemory,
    projectDocs,
    budgetUsedTokens,
    budgetMaxTokens,
    ringBufferCapacity,
    ringBufferUsed,
  } = memoryState;

  const budgetPct = Math.min(100, Math.round((budgetUsedTokens / budgetMaxTokens) * 100));

  return (
    <div className="pg" data-test="shared-memory-page">
      <div className="pg-inner">
        <div className="pg-title">
          <div>
            <h2>Shared Memory Architecture</h2>
            <p>Two-tier state bus: Tier 1 ephemeral working KV &amp; Tier 2 persistent workspace memory</p>
          </div>
        </div>

        {/* Ring Buffer Telemetry Banner */}
        <div className="ring-banner" data-test="ring-banner">
          <div className="ring-head">
            <span>In-DB Ring Buffer Telemetry · Circular Log</span>
            <b>
              {ringBufferUsed} / {ringBufferCapacity} events
            </b>
          </div>
          <div className="budget">
            <span>Shared Memory Budget:</span>
            <b>
              {budgetUsedTokens.toLocaleString()} / {budgetMaxTokens.toLocaleString()} tokens ({budgetPct}%)
            </b>
            <div
              className="meter"
              style={{
                background: 'var(--line)',
                height: 6,
                borderRadius: 3,
                flex: 1,
                overflow: 'hidden',
                marginLeft: 12,
              }}
            >
              <div
                style={{
                  width: `${budgetPct}%`,
                  background: 'var(--accent)',
                  height: '100%',
                  transition: 'width 0.2s ease',
                }}
                data-test="token-budget-bar"
              />
            </div>
          </div>
        </div>

        {/* Two-Tier Overview */}
        <div className="tiers" data-test="memory-tiers">
          <div className="card tier" data-test="tier-1-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="chiplet">Tier 1</span>
              <h3>Working Memory (Ephemeral KV)</h3>
            </div>
            <p>Active turn state, current goal, touched files, and candidate diffs injected into prompt envelopes.</p>
            <div className="stores">
              <span className="chiplet">Auto-compacts on handoff</span>
              <span className="chiplet">&lt; 4,000 tokens</span>
            </div>
          </div>

          <div className="card tier" data-test="tier-2-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="chiplet">Tier 2</span>
              <h3>Project Memory (Persistent Stores)</h3>
            </div>
            <p>Multi-file architecture guides, decision records, and workspace documentation indexed for cross-engine recall.</p>
            <div className="stores">
              <span className="chiplet">.chorus/memory/*.md</span>
              <span className="chiplet">Indexed in SQLite</span>
            </div>
          </div>
        </div>

        {/* Working Memory KV entries list */}
        <div className="mem-list" data-test="working-memory-list">
          <h3 style={{ margin: '8px 0 2px', fontSize: 16, fontWeight: 600 }}>Active Working Keys (Tier 1)</h3>
          {workingMemory.length === 0 ? (
            <div className="card mem" style={{ textAlign: 'center', color: 'var(--muted)' }}>
              No active working keys in memory.
            </div>
          ) : (
            workingMemory.map(item => (
              <div key={item.key} className="card mem" data-test={`memory-entry-${item.key}`}>
                <header>
                  <span className={`mark xs m-${item.updatedBy}`}>
                    {item.updatedBy[0].toUpperCase()}
                  </span>
                  <strong>{item.key}</strong>
                  <span className="chiplet">Updated by {item.updatedBy}</span>
                  <time>{item.updatedAt}</time>
                </header>
                <div className="payload" data-test={`memory-payload-${item.key}`}>
                  {item.value}
                </div>
                <div className="reads">
                  <span>Read by:</span>
                  {item.readBy.map(r => (
                    <span key={r} className={`mark xs m-${r}`} title={r}>
                      {r[0].toUpperCase()}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Project Memory Documents list */}
        <div className="mem-list" data-test="project-docs-list">
          <h3 style={{ margin: '8px 0 2px', fontSize: 16, fontWeight: 600 }}>Project Memory Documents (Tier 2)</h3>
          {projectDocs.length === 0 ? (
            <div className="card mem" style={{ textAlign: 'center', color: 'var(--muted)' }}>
              No project memory documents stored.
            </div>
          ) : (
            projectDocs.map(doc => (
              <div key={doc.id} className="card mem" data-test={`project-doc-${doc.id}`}>
                <header>
                  <strong>{doc.title}</strong>
                  <code>{doc.path}</code>
                  <span className="chiplet">{doc.tokens} tokens</span>
                  <time>{doc.lastModified}</time>
                </header>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                  {doc.excerpt}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

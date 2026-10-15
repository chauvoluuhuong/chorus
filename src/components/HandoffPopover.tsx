import type { FC } from 'react';
import type { AgentId } from '../types';

interface HandoffPopoverProps {
  currentAgent: AgentId;
  onSelectAgent: (agentId: AgentId) => void;
  onClose: () => void;
}

export const HandoffPopover: FC<HandoffPopoverProps> = ({
  currentAgent,
  onSelectAgent,
}) => {
  const candidates: {
    id: AgentId;
    name: string;
    model: string;
    quota: string;
    desc: string;
  }[] = [
    {
      id: 'codex',
      name: 'Codex',
      model: 'GPT Codex',
      quota: '92% quota remaining',
      desc: 'Optimized for deep refactors and test generation',
    },
    {
      id: 'agy',
      name: 'Antigravity',
      model: 'Gemini 2.5 Pro',
      quota: '84% quota remaining',
      desc: 'Large context window (1M tokens) with multi-file reasoning',
    },
    {
      id: 'claude',
      name: 'Claude Code',
      model: 'Sonnet 3.7',
      quota: '45% quota remaining',
      desc: 'Fast architecture design, frontend UI, and debugging',
    },
  ];

  const available = candidates.filter(c => c.id !== currentAgent);

  return (
    <div className="handoff-popover" data-test="handoff-popover">
      <div className="handoff-pop-head">
        <strong>⇄ Hand off active conversation</strong>
        <small>Transfer context, recent goals, and touched files (&lt;150 tokens)</small>
      </div>

      <div className="handoff-pop-list">
        {available.map(c => (
          <button
            key={c.id}
            type="button"
            className="handoff-pop-item"
            data-test={`handoff-agent-opt-${c.id}`}
            onClick={() => onSelectAgent(c.id)}
          >
            <span className={`mark xs m-${c.id}`}>{c.id[0].toUpperCase()}</span>
            <div className="info">
              <div className="row-name">
                <strong>{c.name}</strong>
                <span className="tag-model">{c.model}</span>
              </div>
              <small>{c.quota} · {c.desc}</small>
            </div>
            <span className="action-arr">→</span>
          </button>
        ))}
      </div>
    </div>
  );
};

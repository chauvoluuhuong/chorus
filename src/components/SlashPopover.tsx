import { useEffect, type FC } from 'react';
import type { SkillBundle } from '../types';

interface SlashPopoverProps {
  query: string;
  skills: SkillBundle[];
  onSelect: (command: string) => void;
  onClose: () => void;
}

export const SlashPopover: FC<SlashPopoverProps> = ({
  query,
  skills,
  onSelect,
  onClose,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  const builtInActions = [
    { command: '/handoff', name: 'Hand off context', desc: 'Transfer state to another AI model' },
    { command: '/sync-skills', name: 'Sync skills', desc: 'Scan and import skills from disk' },
    { command: '/compact', name: 'Compact context', desc: 'Summarize history to save tokens' },
  ];

  const allItems = [
    ...skills.map(s => ({
      command: s.command.startsWith('/') ? s.command : `/${s.command}`,
      name: s.name,
      desc: s.description,
      isSkill: true,
    })),
    ...builtInActions.map(a => ({
      ...a,
      isSkill: false,
    })),
  ];

  const filtered = allItems.filter(item => {
    if (!query) return true;
    const q = query.replace(/^\//, '').toLowerCase();
    return item.command.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
  });

  return (
    <div className="mention-popover slash-popover" data-test="slash-popover">
      <div className="sb-label" style={{ padding: '4px 6px 6px' }}>
        Skills & Actions
      </div>
      <div className="mention-list" data-test="slash-list">
        {filtered.length === 0 ? (
          <div style={{ padding: '8px 10px', color: 'var(--muted)', fontSize: 13 }}>
            No matching skills or commands
          </div>
        ) : (
          filtered.map(item => (
            <button
              key={item.command}
              className="mention-item"
              data-test={`slash-item-${item.command}`}
              onClick={() => onSelect(item.command)}
            >
              <span className="icon">{item.isSkill ? '⚡' : '⚙️'}</span>
              <div className="info">
                <strong>{item.command}</strong>
                <small>{item.desc}</small>
              </div>
              <span className="mention-badge">{item.isSkill ? 'Skill' : 'Action'}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

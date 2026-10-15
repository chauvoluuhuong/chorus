import type { FC } from 'react';
import type { ApprovalRequest } from '../types';

interface InlineApprovalCardProps {
  approval: ApprovalRequest;
  onAllow: (approval: ApprovalRequest) => void;
  onDeny: (approval: ApprovalRequest) => void;
}

export const InlineApprovalCard: FC<InlineApprovalCardProps> = ({
  approval,
  onAllow,
  onDeny,
}) => {
  return (
    <div
      className="inline-approval"
      data-test="inline-approval-card"
      data-status={approval.status}
    >
      <div className="inline-approval-title">
        <span>⚠️ Privileged Command Approval Required</span>
        <span style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--muted)' }}>
          {approval.risk}
        </span>
      </div>

      <div className="inline-approval-cmd" data-test="approval-command-text">
        {approval.command}
      </div>

      {approval.status === 'pending' ? (
        <div className="btns">
          <button
            type="button"
            className="btn sm btn-dark"
            data-test="approval-allow-btn"
            onClick={() => onAllow(approval)}
          >
            Allow (y)
          </button>
          <button
            type="button"
            className="btn sm"
            data-test="approval-deny-btn"
            onClick={() => onDeny(approval)}
          >
            Don't allow (n)
          </button>
        </div>
      ) : approval.status === 'allowed' ? (
        <div style={{ fontSize: 12.5, color: 'var(--ok)', fontWeight: 500 }}>
          ✓ Allowed · piped y to stdin
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--bad)', fontWeight: 500 }}>
          ✕ Denied · You chose Don't allow
        </div>
      )}
    </div>
  );
};

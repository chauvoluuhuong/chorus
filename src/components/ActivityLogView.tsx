import { useState, type FC } from 'react';
import type { ActivityEvent, ActivityTelemetry } from '../types';

interface ActivityLogViewProps {
  events: ActivityEvent[];
  telemetry: ActivityTelemetry;
}

export const ActivityLogView: FC<ActivityLogViewProps> = ({ events, telemetry }) => {
  const [filter, setFilter] = useState<string>('all');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    events.length > 0 ? events[0].id : null,
  );

  const filters = ['all', 'workspace', 'bridge', 'appr', 'hook', 'err'];

  const filteredEvents = events.filter(ev => {
    if (filter === 'all') return true;
    return ev.type === filter;
  });

  const selectedEvent = events.find(ev => ev.id === selectedEventId) || filteredEvents[0] || null;

  return (
    <div className="pg" data-test="activity-log-page">
      <div className="pg-inner">
        <div className="pg-title">
          <div>
            <h2>Activity Log &amp; Telemetry</h2>
            <p>Zero-overhead In-DB Ring Buffer telemetry: event traces, tool calls, and IPC transactions</p>
          </div>
        </div>

        {/* Telemetry Stats Cards */}
        <div className="stats" data-test="activity-stats">
          <div className="card stat" data-test="stat-total-events">
            <b>{telemetry.totalEvents}</b>
            <span>Total Ring Buffer Events</span>
          </div>
          <div className="card stat" data-test="stat-tool-calls">
            <b>{telemetry.toolCalls}</b>
            <span>Tool Calls Executed</span>
          </div>
          <div className="card stat" data-test="stat-approvals">
            <b>{telemetry.approvals}</b>
            <span>Privilege Approvals</span>
          </div>
          <div className="card stat" data-test="stat-handoffs">
            <b>{telemetry.handoffs}</b>
            <span>Engine Handoffs</span>
          </div>
        </div>

        {/* Filters Bar */}
        <div className="filters" data-test="activity-filters">
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500, marginRight: 4 }}>
            Filter by type:
          </span>
          {filters.map(f => (
            <button
              key={f}
              type="button"
              className={`chip ${filter === f ? 'on' : ''}`}
              data-test={`filter-btn-${f}`}
              style={{
                cursor: 'pointer',
                background: filter === f ? 'var(--ink)' : 'var(--surface)',
                color: filter === f ? 'var(--bg)' : 'var(--ink-2)',
                borderColor: filter === f ? 'var(--ink)' : 'var(--line)',
                fontWeight: filter === f ? 600 : 400,
                textTransform: 'capitalize',
              }}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Events Table */}
        <div className="card log" data-test="activity-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Agent</th>
                <th>Summary</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: 'var(--muted)' }}>
                    No activity events match filter "{filter}".
                  </td>
                </tr>
              ) : (
                filteredEvents.map(ev => (
                  <tr
                    key={ev.id}
                    className={`ev ${selectedEvent?.id === ev.id ? 'sel' : ''}`}
                    data-test={`event-row-${ev.id}`}
                    onClick={() => setSelectedEventId(ev.id)}
                  >
                    <td className="t">{ev.timestamp}</td>
                    <td>
                      <span className={`etype ${ev.type}`}>{ev.type}</span>
                    </td>
                    <td>
                      <span className={`mark xs m-${ev.agent}`}>{ev.agent[0].toUpperCase()}</span>
                    </td>
                    <td style={{ fontWeight: 500 }}>{ev.summary}</td>
                    <td className="t">{ev.durationMs ? `${ev.durationMs}ms` : '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Selected Event Details Pane */}
        {selectedEvent && (
          <div className="card mem" data-test="event-detail-pane">
            <header>
              <strong>Event Detail: {selectedEvent.id}</strong>
              <span className={`etype ${selectedEvent.type}`}>{selectedEvent.type}</span>
              <span className={`mark xs m-${selectedEvent.agent}`}>
                {selectedEvent.agent[0].toUpperCase()}
              </span>
              <time>{selectedEvent.timestamp}</time>
            </header>
            <div className="detail-grid">
              <div>
                <h4>Event Metadata</h4>
                <div className="payload" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div>
                    <strong>Summary:</strong> {selectedEvent.summary}
                  </div>
                  <div>
                    <strong>Origin Agent:</strong> {selectedEvent.agent}
                  </div>
                  <div>
                    <strong>Duration:</strong>{' '}
                    {selectedEvent.durationMs ? `${selectedEvent.durationMs}ms` : 'Immediate'}
                  </div>
                </div>
              </div>
              <div>
                <h4>JSON Payload</h4>
                <pre className="json" data-test="event-json-payload">
                  {JSON.stringify(selectedEvent.meta, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

import { useEffect, useRef } from "react";
import type { AgentLogEntry } from "../../shared/types";

interface ActionLogProps {
  logs: AgentLogEntry[];
}

export function ActionLog({ logs }: ActionLogProps) {
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [logs.length]);

  return (
    <section className="panel log-panel" aria-label="Action log">
      <div className="section-heading">
        <h2>Action Log</h2>
        <span>{logs.length}</span>
      </div>
      <ol ref={listRef}>
        {logs.length === 0 ? <li className="empty-log">No actions yet.</li> : null}
        {logs.map((entry) => (
          <li key={entry.id} className={`log-entry ${entry.level}`}>
            <div className="log-meta">
              <time>{formatTime(entry.timestamp)}</time>
              <span>{entry.level}</span>
            </div>
            <p className="log-message">{entry.message}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

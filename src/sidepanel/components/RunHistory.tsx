import { useState } from "react";
import type { RunReport } from "../../shared/types";
import { Markdown } from "./Markdown";

interface RunHistoryProps {
  reports: RunReport[];
  running: boolean;
  onRerun: (task: string) => Promise<void>;
  onDelete: (runId: string) => Promise<void>;
  onClear: () => Promise<void>;
}

export function RunHistory({ reports, running, onRerun, onDelete, onClear }: RunHistoryProps) {
  const [copiedId, setCopiedId] = useState<string>();

  async function copyReport(report: RunReport) {
    await navigator.clipboard.writeText(formatRunReport(report));
    setCopiedId(report.id);
    window.setTimeout(() => setCopiedId((current) => current === report.id ? undefined : current), 1500);
  }

  return (
    <section className="history-panel" aria-label="Run history">
      <div className="section-heading">
        <h2>Run History</h2>
        <span>{reports.length}</span>
      </div>

      <div className="history-toolbar">
        <p>Stored locally in this browser profile.</p>
        <button className="danger-button subtle-danger" disabled={!reports.length || running} onClick={() => void onClear()}>
          Clear
        </button>
      </div>

      {reports.length === 0 ? <p className="empty-history">No saved runs yet.</p> : null}

      <div className="run-report-list">
        {reports.map((report) => {
          const progress = getRequirementProgress(report);
          return (
            <article className="run-report" key={report.id}>
              <header className="run-report-header">
                <div>
                  <span className={`run-status ${report.status}`}>{formatStatus(report.status)}</span>
                  <time>{formatDate(report.startedAt)}</time>
                </div>
                <strong>{report.task}</strong>
              </header>

              <div className="run-report-metrics">
                <span>{progress.satisfied}/{progress.total} requirements</span>
                <span>{report.findings.length} findings</span>
                <span>{report.usage.totalTokens.toLocaleString()} tokens</span>
              </div>

              {report.finalReport ? (
                <div className="run-report-output">
                  <Markdown text={report.finalReport} />
                </div>
              ) : report.failureReason ? (
                <p className="run-report-error">{report.failureReason}</p>
              ) : null}

              {report.findings.length ? (
                <details className="run-findings">
                  <summary>Findings</summary>
                  <ol>
                    {report.findings.map((finding) => (
                      <li key={finding.id}>
                        <strong>{finding.label}</strong>
                        <Markdown text={finding.text} />
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}

              <div className="button-row run-report-actions">
                <button className="secondary-button" onClick={() => void copyReport(report)}>
                  {copiedId === report.id ? "Copied" : "Copy"}
                </button>
                <button className="primary-button" disabled={running} onClick={() => void onRerun(report.task)}>
                  Run Again
                </button>
                <button className="danger-button subtle-danger" disabled={running} onClick={() => void onDelete(report.id)}>
                  Delete
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function getRequirementProgress(report: RunReport): { satisfied: number; total: number } {
  let satisfied = 0;
  let total = 0;
  for (const requirement of report.requirements) {
    const statuses = requirement.items?.length
      ? requirement.items.map((item) => item.status)
      : [requirement.status];
    total += statuses.length;
    satisfied += statuses.filter((status) => status === "satisfied").length;
  }
  return { satisfied, total };
}

function formatRunReport(report: RunReport): string {
  const progress = getRequirementProgress(report);
  const findings = report.findings.length
    ? ["", "## Findings", ...report.findings.map((finding) => `### ${finding.label}\n${finding.text}`)]
    : [];
  return [
    `# ${report.task}`,
    `Status: ${formatStatus(report.status)}`,
    `Requirements: ${progress.satisfied}/${progress.total} satisfied`,
    report.finalReport ? `\n${report.finalReport}` : "",
    report.failureReason ? `\nReason: ${report.failureReason}` : "",
    ...findings,
  ].filter(Boolean).join("\n");
}

function formatStatus(status: RunReport["status"]): string {
  return status.replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

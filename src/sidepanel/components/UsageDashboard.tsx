import { useState } from "react";
import type { AgentUsageSnapshot, JevStageTiming, JevTimingStage } from "../../shared/types";
import { buildJevTraceExport, downloadJson, fetchJevTrace } from "../jevTraceExport";

const TIMING_LABELS: Record<JevTimingStage, string> = {
  snapshot: "Page snapshot", jev: "Jev request", action: "Browser action", llm: "LLM planner",
};

interface UsageDashboardProps {
  usage: AgentUsageSnapshot;
}

export function UsageDashboard({ usage }: UsageDashboardProps) {
  const [traceNotice, setTraceNotice] = useState<string>();
  const cacheHitRate = usage.promptTokens
    ? Math.round((usage.cachedPromptTokens / usage.promptTokens) * 100)
    : 0;

  async function exportTrace() {
    try {
      const entries = await fetchJevTrace();
      if (!entries.length) {
        setTraceNotice("No Jev decisions to export yet.");
        return;
      }
      downloadJson(`jev-trace-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, buildJevTraceExport(entries));
      setTraceNotice(`Exported ${entries.length} decisions. The file has no task text, page text or field values.`);
    } catch (error) {
      setTraceNotice(error instanceof Error ? error.message : "Could not read the Jev trace.");
    }
  }

  return (
    <section className="panel usage-panel" aria-label="Token and cost dashboard">
      <div className="section-heading">
        <h2>Token Console</h2>
        <span>{usage.requestCount}</span>
      </div>

      <div className="usage-grid usage-grid-primary">
        <Metric label="LLM tokens" value={formatInteger(usage.totalTokens)} />
        <Metric label="Cached" value={`${formatInteger(usage.cachedPromptTokens)} (${cacheHitRate}%)`} />
        <Metric label="Avg latency" value={formatDuration(usage.averageLatencyMs)} />
        <Metric label="LLM cost est." value={formatCost(usage)} />
      </div>

      <details className="usage-details">
        <summary>Request details</summary>
        <div className="usage-grid usage-grid-secondary">
          <Metric label="Prompt" value={formatInteger(usage.promptTokens)} />
          <Metric label="Output" value={formatInteger(usage.completionTokens)} />
          <Metric label="Cache hits" value={`${usage.cacheHitRequestCount}/${usage.requestCount || 0}`} />
          <Metric label="Last latency" value={formatDuration(usage.lastLatencyMs)} />
        </div>
      </details>

      {usage.jev ? (
        <details className="usage-details" open>
          <summary>Jev decisions</summary>
          <div className="usage-grid usage-grid-secondary">
            <Metric label="Jev requests" value={formatInteger(usage.jev.requests)} />
            <Metric label="Fast decisions" value={formatInteger(usage.jev.fastDecisions)} />
            <Metric label="Text helper calls" value={formatInteger(usage.jev.helperRequests || 0)} />
            <Metric label="Shadow choices" value={formatInteger(usage.jev.shadowDecisions)} />
            <Metric label="Fallbacks" value={formatInteger(usage.jev.fallbacks)} />
            <Metric label="Jev avg latency" value={formatDuration(usage.jev.requests ? usage.jev.totalLatencyMs / usage.jev.requests : undefined)} />
            <Metric label="Jev input tokens" value={formatInteger(usage.jev.inputTokens)} />
            <Metric label="Jev output tokens" value={formatInteger(usage.jev.outputTokens)} />
            <Metric label="Jev cost est." value={`$${usage.jev.estimatedCostUsd.toFixed(6)}`} />
            <Metric label="Jev retries" value={formatInteger(usage.jev.retries || 0)} />
            {usage.jev.lastModel ? <Metric label="Jev model" value={usage.jev.lastModel} /> : null}
          </div>
          <button type="button" className="secondary-button" onClick={() => void exportTrace()}>Download Jev trace</button>
          {traceNotice ? <p className="storage-note" role="status">{traceNotice}</p> : null}
        </details>
      ) : null}

      {usage.jev?.timings && Object.keys(usage.jev.timings).length ? (
        <details className="usage-details">
          <summary>Jev step timings</summary>
          <div className="usage-grid usage-grid-secondary">
            {(Object.entries(usage.jev.timings) as Array<[JevTimingStage, JevStageTiming]>).map(([stage, timing]) => (
              <Metric key={stage} label={`${TIMING_LABELS[stage]} (${timing.count})`}
                value={`avg ${formatDuration(timing.count ? timing.totalMs / timing.count : undefined)} / max ${formatDuration(timing.maxMs)}`} />
            ))}
          </div>
        </details>
      ) : null}

      {usage.jev?.lastDecision?.length ? (
        <details className="usage-details jev-decision-inspector">
          <summary>Latest Jev decision</summary>
          <dl>
            {usage.jev.lastDecision.map((answer) => (
              <div key={answer.question}>
                <dt>{answer.question.replaceAll("_", " ")}</dt>
                <dd>
                  <strong>{answer.choice} <span>{Math.round(answer.confidence * 100)}%</span></strong>
                  <small>{answer.probabilities.map((option) => `${option.option}: ${Math.round(option.probability * 100)}%`).join(" / ")}</small>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      <div className="usage-footer">
        <span>{usage.provider || "provider"}</span>
        <span>{usage.model || "model"}</span>
        {usage.lastStatus ? <span>status {usage.lastStatus}</span> : null}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatDuration(value: number | undefined): string {
  if (!value) {
    return "--";
  }

  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }

  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatCost(usage: AgentUsageSnapshot): string {
  if (!usage.costConfigured || typeof usage.estimatedCostUsd !== "number") {
    return "Set rates";
  }

  if (usage.estimatedCostUsd === 0) {
    return "$0.000000";
  }

  return `$${usage.estimatedCostUsd.toFixed(usage.estimatedCostUsd < 0.01 ? 6 : 4)}`;
}

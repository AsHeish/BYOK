import type { AgentUsageSnapshot } from "../../shared/types";

interface UsageDashboardProps {
  usage: AgentUsageSnapshot;
}

export function UsageDashboard({ usage }: UsageDashboardProps) {
  const cacheHitRate = usage.promptTokens
    ? Math.round((usage.cachedPromptTokens / usage.promptTokens) * 100)
    : 0;

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

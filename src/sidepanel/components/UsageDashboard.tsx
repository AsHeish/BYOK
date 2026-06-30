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

      <div className="usage-grid">
        <Metric label="Total tokens" value={formatInteger(usage.totalTokens)} />
        <Metric label="Prompt" value={formatInteger(usage.promptTokens)} />
        <Metric label="Output" value={formatInteger(usage.completionTokens)} />
        <Metric label="Cached" value={`${formatInteger(usage.cachedPromptTokens)} (${cacheHitRate}%)`} />
        <Metric label="Cache hits" value={`${usage.cacheHitRequestCount}/${usage.requestCount || 0}`} />
        <Metric label="Avg latency" value={formatDuration(usage.averageLatencyMs)} />
        <Metric label="Last latency" value={formatDuration(usage.lastLatencyMs)} />
        <Metric label="Cost est." value={formatCost(usage)} />
      </div>

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

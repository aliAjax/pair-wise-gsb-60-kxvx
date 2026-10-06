import { get } from 'svelte/store';
import type { SignalCase, SignalFilters } from '$lib/models/signal';
import { signalStore } from '$lib/stores/signal-store';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listSignals(filters: SignalFilters = {}): Promise<SignalCase[]> {
  await wait(80);
  const query = filters.query?.trim().toLowerCase();

  return signalStore
    .getSnapshot()
    .filter((signal) => {
      const matchesQuery =
        !query ||
        [signal.id, signal.title, signal.product, signal.batch]
          .join(' ')
          .toLowerCase()
          .includes(query);
      const matchesStatus = !filters.status || filters.status === 'all' || signal.status === filters.status;
      const matchesRisk =
        !filters.riskLevel || filters.riskLevel === 'all' || signal.riskLevel === filters.riskLevel;
      const matchesSource =
        !filters.sourceType || filters.sourceType === 'all' || signal.sourceType === filters.sourceType;
      return matchesQuery && matchesStatus && matchesRisk && matchesSource;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function exportSignalReport(id: string) {
  const signal = get(signalStore).find((item) => item.id === id);
  if (!signal) return;

  const activeConclusion = signal.versions.find((version) => version.state === 'active');
  const stale = !activeConclusion;
  const report = {
    generatedAt: new Date().toISOString(),
    caseId: signal.id,
    product: signal.product,
    batch: signal.batch,
    failureMode: signal.failureMode,
    failureModeLabel: signal.failureModeLabel,
    status: signal.status,
    riskLevel: signal.riskLevel,
    conclusion: activeConclusion?.summary ?? null,
    /** true 表示旧结论已失效且重算尚未保存成功，导出件不得作为生效判断依据 */
    conclusionStale: stale,
    staleNotice: stale ? '当前无生效结论：证据已变化，重算保存成功前本字段为空。' : undefined,
    externalReportIds: signal.externalReportIds,
    evidence: signal.evidence,
    versionHistory: signal.versions.map((version) => ({
      version: version.version,
      state: version.state,
      summary: version.summary,
      invalidatedReason: version.invalidatedReason,
      supersededBy: version.supersededBy
    })),
    audit: signal.audit
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${signal.id}-traceability-report.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

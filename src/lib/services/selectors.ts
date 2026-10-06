import type { AuditEntry, RiskLevel, SignalCase } from '$lib/models/signal';
import type { ImportRun } from '$lib/models/report-package';

export interface BatchStat {
  batch: string;
  products: string[];
  signalCount: number;
  reportCount: number;
  evidenceCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  topRisk: RiskLevel;
  pendingRecompute: number;
}

const riskRank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** 批次统计：信号变化（建案/归并/重算）后同步重算 */
export function computeBatchStats(signals: SignalCase[]): BatchStat[] {
  const map = new Map<string, BatchStat>();

  for (const signal of signals) {
    for (const batch of signal.affectedBatches) {
      let stat = map.get(batch);
      if (!stat) {
        stat = {
          batch,
          products: [],
          signalCount: 0,
          reportCount: 0,
          evidenceCount: 0,
          exposedUnits: 0,
          occurrenceRate: 0,
          topRisk: 'low',
          pendingRecompute: 0
        };
        map.set(batch, stat);
      }
      stat.signalCount += 1;
      stat.reportCount += signal.reportCount;
      stat.evidenceCount += signal.evidence.filter((item) => item.batch === batch).length;
      if (!stat.products.includes(signal.product)) stat.products.push(signal.product);
      // 暴露台数按主批号归属，避免同一数字在多批号间重复累计
      if (signal.batch === batch) stat.exposedUnits += signal.exposedUnits;
      if (riskRank[signal.riskLevel] > riskRank[stat.topRisk]) stat.topRisk = signal.riskLevel;
      if (signal.recomputePending) stat.pendingRecompute += 1;
    }
  }

  for (const stat of map.values()) {
    stat.occurrenceRate =
      stat.exposedUnits > 0 ? +((stat.reportCount / stat.exposedUnits) * 100).toFixed(2) : 0;
  }

  return Array.from(map.values()).sort((a, b) => a.batch.localeCompare(b.batch));
}

export interface OverviewMetrics {
  openSignals: number;
  highRiskSignals: number;
  openTasks: number;
  overdueTasks: number;
  pendingRecompute: number;
  importedReports: number;
  failedImports: number;
}

/** 总览指标：案例、导入批次任一变化都反映到这里 */
export function computeOverview(signals: SignalCase[], runs: ImportRun[]): OverviewMetrics {
  const today = new Date().toISOString().slice(0, 10);
  return {
    openSignals: signals.filter((signal) => signal.status !== 'closed').length,
    highRiskSignals: signals.filter(
      (signal) => signal.riskLevel === 'critical' || signal.riskLevel === 'high'
    ).length,
    openTasks: signals.flatMap((signal) => signal.tasks).filter((task) => task.status !== 'done')
      .length,
    overdueTasks: signals
      .flatMap((signal) => signal.tasks)
      .filter((task) => task.status !== 'done' && task.dueAt < today).length,
    pendingRecompute: signals.filter((signal) => signal.recomputePending).length,
    importedReports: runs.reduce(
      (sum, run) =>
        sum + run.items.filter((item) => item.outcome === 'created' || item.outcome === 'merged')
          .length,
      0
    ),
    failedImports: runs.filter((run) => run.status === 'failed').length
  };
}

export interface UnifiedAuditEntry extends AuditEntry {
  signalId?: string;
  product?: string;
  scope: 'case' | 'import';
}

/** 统一审计时间线：案例审计 + 导入批次事件 */
export function buildAuditTimeline(signals: SignalCase[], runs: ImportRun[]): UnifiedAuditEntry[] {
  const caseEntries: UnifiedAuditEntry[] = signals.flatMap((signal) =>
    signal.audit.map((entry) => ({
      ...entry,
      signalId: signal.id,
      product: signal.product,
      scope: 'case' as const
    }))
  );

  const importEntries: UnifiedAuditEntry[] = runs.flatMap((run) =>
    run.events.map((event) => ({
      id: `${run.id}-${event.at}-${event.stage}`,
      actor: run.team,
      action: stageLabel(event.stage),
      detail: event.message,
      createdAt: event.at,
      externalReportId: event.externalReportId,
      importBatchId: run.packageId,
      signalId: event.signalId,
      scope: 'import' as const
    }))
  );

  return [...caseEntries, ...importEntries].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    start: '开始接收',
    receive: '报告入账',
    recompute: '结论重算',
    duplicate: '重复跳过',
    failed: '接收失败',
    resume: '断点续作',
    complete: '接收完成'
  };
  return labels[stage] ?? stage;
}

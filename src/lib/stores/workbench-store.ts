import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  RiskLevel,
  SignalCase,
  SignalStatus
} from '$lib/models/signal';
import {
  failureModeLabel,
  type ExternalReport,
  type ImportBatch,
  type ImportItemState,
  type RecomputeJob,
  type WorkbenchStateV2
} from '$lib/models/report-package';
import { seedSignals } from '$lib/services/seed';
import { migrateV1ToV2, LEGACY_KEY } from '$lib/services/migration';
import { buildRecomputedVersion, recomputeConclusion } from '$lib/services/conclusion';
import { consumeIngestFailure, consumeRecomputeFailure } from '$lib/services/fault-injection';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'medical-safety-workbench-v2';

export function now() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function seedState(): WorkbenchStateV2 {
  return {
    schemaVersion: 2,
    signals: structuredClone(seedSignals),
    importBatches: [],
    recomputeJobs: [],
    externalLedger: seedSignals.flatMap((signal) =>
      signal.externalReportIds.map((externalReportId) => ({
        externalReportId,
        caseId: signal.id,
        importBatchId: 'BASELINE-LEDGER',
        at: signal.openedAt
      }))
    ),
    migratedFromV1: false,
    activeImportId: null
  };
}

function readPersisted(): WorkbenchStateV2 {
  if (!browser) return seedState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkbenchStateV2;
      return normalizeState(parsed);
    }
    // 旧版本数据：升级时保留原审计，回填外部报告标识后继续参与计算
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (Array.isArray(legacy)) {
        const migrated = migrateV1ToV2(legacy as SignalCase[], now());
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        // 迁移成功后旧键不再作为数据源（内容已完整保留在 v2 中）
        localStorage.removeItem(LEGACY_KEY);
        return migrated;
      }
    }
  } catch {
    // 解析失败不影响内置台账可用性
  }
  return seedState();
}

/** 对历史写入的状态做字段兜底，保证新版本代码读取旧缓存不崩 */
function normalizeState(state: Partial<WorkbenchStateV2>): WorkbenchStateV2 {
  return {
    schemaVersion: 2,
    signals: state.signals ?? [],
    importBatches: state.importBatches ?? [],
    recomputeJobs: state.recomputeJobs ?? [],
    externalLedger: state.externalLedger ?? [],
    migratedFromV1: state.migratedFromV1 ?? false,
    migratedAt: state.migratedAt,
    activeImportId: state.activeImportId ?? null
  };
}

const internal = writable<WorkbenchStateV2>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // 存储空间不足等写入失败由调用方感知，这里不破坏内存态
    }
  });
}

/* ------------------------------------------------------------------ */
/* 事务原语：所有多表写入（案例 + 台账 + 批次项）在同一次同步更新中提交， */
/* 任何一步抛错都整体放弃，绝不留下半套案例 / 半条入账记录。              */
/* ------------------------------------------------------------------ */

function commit(mutator: (draft: WorkbenchStateV2) => void): WorkbenchStateV2 {
  let result!: WorkbenchStateV2;
  internal.update((state) => {
    const draft = structuredClone(state);
    mutator(draft);
    result = draft;
    return draft;
  });
  return result;
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string, at = now()) {
  const entry: AuditEntry = { id: makeId('AUD'), actor, action, detail, createdAt: at };
  signal.audit.unshift(entry);
  signal.updatedAt = at;
  return entry;
}

export function caseKey(product: string, batch: string, failureMode: string) {
  // 归并规则：新产品或新批号建立案例；产品与批号都已存在时，按故障模式归并。
  // 相邻批号的同类报告（如 260401 vs 260403）建立独立案例，再由人工/后续链路关联。
  return `${product.trim()}｜${batch.trim()}｜${failureMode.trim()}`;
}

function findCaseByKey(draft: WorkbenchStateV2, report: ExternalReport): SignalCase | undefined {
  const key = caseKey(report.product, report.batch, report.failureMode);
  return draft.signals.find(
    (signal) => caseKey(signal.product, signal.batch, signal.failureMode) === key
  );
}

/* ------------------------------------------------------------------ */
/* 结论失效：证据变化的同一事务内立即标记旧结论失效，                      */
/* 批次统计 / 总览 / 审计同步更新；新结论由异步重算成功后才恢复生效。      */
/* ------------------------------------------------------------------ */

function invalidateConclusions(
  signal: SignalCase,
  reason: string,
  at: string
): number {
  let invalidated = 0;
  for (const version of signal.versions) {
    if (version.state === 'active') {
      version.state = 'invalidated';
      version.invalidatedReason = reason;
      version.invalidatedAt = at;
      invalidated += 1;
    }
  }
  return invalidated;
}

function recomputeStats(signal: SignalCase) {
  if (signal.exposedUnits > 0) {
    signal.occurrenceRate = Number(((signal.reportCount / signal.exposedUnits) * 100).toFixed(2));
  }
  let riskLevel = maxRisk(riskFromSeverity(signal.severity), signal.reportCount >= 10 ? 'high' : 'low');
  if (signal.exposedUnits > 0 && signal.occurrenceRate >= 2) riskLevel = maxRisk(riskLevel, 'critical');
  else if (signal.exposedUnits > 0 && signal.occurrenceRate >= 0.75) riskLevel = maxRisk(riskLevel, 'high');
  signal.riskLevel = riskLevel;
}

function nextCaseId(draft: WorkbenchStateV2): string {
  const year = new Date().getFullYear();
  const maxSerial = draft.signals.reduce((max, signal) => {
    const match = /^SIG-\d{4}-(\d+)$/.exec(signal.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 18);
  return `SIG-${year}-${String(maxSerial + 1).padStart(3, '0')}`;
}

function evidenceFromReport(report: ExternalReport, batchId: string, at: string): EvidenceItem {
  return {
    id: makeId('E'),
    type: report.kind,
    title: report.title,
    source: report.source,
    strength: report.strength,
    batch: report.batch,
    note: report.note,
    createdAt: at,
    externalReportId: report.externalReportId,
    importBatchId: batchId
  };
}

export type IngestOutcome =
  | { outcome: 'duplicate'; externalReportId: string; firstIngestedBy?: string; caseId?: string }
  | {
      outcome: 'ingested';
      externalReportId: string;
      caseId: string;
      action: 'created' | 'merged';
      invalidatedVersions: number;
      reopened: boolean;
    };

/**
 * 单条外部报告入账（幂等 + 归并 + 新建），事务原子提交。
 * 失败在提交前抛出，调用方据此把批次项标记为 failed，状态中不会留下任何半成品。
 */
export function ingestReport(report: ExternalReport, batchId: string): IngestOutcome {
  const snapshot = get(internal);

  // 幂等：全局台账与案例内报告号任一命中即视为重复，重复导入只入账一次
  const ledgerHit = snapshot.externalLedger.find(
    (entry) => entry.externalReportId === report.externalReportId
  );
  if (ledgerHit) {
    commit((draft) => touchDuplicate(draft, batchId, report.externalReportId, ledgerHit.importBatchId));
    return {
      outcome: 'duplicate',
      externalReportId: report.externalReportId,
      firstIngestedBy: ledgerHit.importBatchId,
      caseId: ledgerHit.caseId
    };
  }

  // 故障注入：模拟“接收失败”，发生在事务之前 → 没有任何部分写入
  if (consumeIngestFailure(report.externalReportId)) {
    throw new Error(`报告 ${report.externalReportId} 接收失败（模拟网络/写入故障）`);
  }

  const at = now();
  let outcome: IngestOutcome | undefined;

  commit((draft) => {
    // 双重检查：同一事务边界内再次确认幂等
    const existingLedger = draft.externalLedger.find(
      (entry) => entry.externalReportId === report.externalReportId
    );
    if (existingLedger) {
      touchDuplicate(draft, batchId, report.externalReportId, existingLedger.importBatchId);
      outcome = {
        outcome: 'duplicate',
        externalReportId: report.externalReportId,
        firstIngestedBy: existingLedger.importBatchId,
        caseId: existingLedger.caseId
      };
      return;
    }

    const batch = draft.importBatches.find((item) => item.id === batchId);
    let signal = findCaseByKey(draft, report);
    let action: 'created' | 'merged';
    let reopened = false;
    let invalidatedVersions = 0;

    if (signal) {
      action = 'merged';
      // 已有产品和批号且故障模式一致 → 归并到现有案例
      signal.evidence.unshift(evidenceFromReport(report, batchId, at));
      signal.externalReportIds.push(report.externalReportId);
      signal.reportCount += 1;
      signal.severity = Math.max(signal.severity, report.severity);
      if (typeof report.exposedUnits === 'number' && report.exposedUnits > signal.exposedUnits) {
        signal.exposedUnits = report.exposedUnits;
      }
      if (report.occurredAt < signal.occurredAt) signal.occurredAt = report.occurredAt;
      // 已关闭案例收到新证据：不允许静默改结论，自动重开并失效旧结论
      if (signal.status === 'closed') {
        signal.status = 'investigating';
        signal.reopenedCount += 1;
        reopened = true;
        appendAudit(
          signal,
          '系统',
          '重新打开',
          `已关闭案例收到新外部报告 ${report.externalReportId}，自动重开并要求结论重算。`,
          at
        );
      }
      invalidatedVersions = invalidateConclusions(
        signal,
        `外部报告 ${report.externalReportId} 归并入账，证据矩阵发生变化`,
        at
      );
      if (invalidatedVersions > 0) {
        appendAudit(
          signal,
          '系统',
          '结论失效',
          `外部报告 ${report.externalReportId} 入账：${invalidatedVersions} 个生效结论已失效，等待重算保存后恢复。`,
          at
        );
      }
      appendAudit(
        signal,
        '安全运营组',
        '归并外部报告',
        `报告包批次 ${batchId}：${report.externalReportId}（${failureModeLabel(report.failureMode)}）并入本案例。`,
        at
      );
      recomputeStats(signal);
    } else {
      action = 'created';
      // 新产品或新批号（或新故障模式）→ 建立新案例，尚无结论，重算阶段生成首版
      const created: SignalCase = {
        id: nextCaseId(draft),
        title: `${report.product}「${failureModeLabel(report.failureMode)}」${report.batch} 批信号`,
        product: report.product,
        batch: report.batch,
        failureMode: report.failureMode,
        failureModeLabel: failureModeLabel(report.failureMode),
        sourceType: report.kind === 'adverse_event' ? 'adverse_event' : report.kind,
        status: 'new',
        riskLevel: riskFromSeverity(report.severity),
        severity: report.severity,
        reportCount: 1,
        exposedUnits: report.exposedUnits ?? 0,
        occurrenceRate: report.exposedUnits ? Number(((1 / report.exposedUnits) * 100).toFixed(2)) : 0,
        occurredAt: report.occurredAt,
        openedAt: at,
        updatedAt: at,
        owner: '待分派',
        description: report.note,
        affectedBatches: [report.batch],
        evidence: [evidenceFromReport(report, batchId, at)],
        tasks: [
          {
            id: makeId('TASK'),
            title: '核对离线报告来源记录与产品批号',
            owner: '待分派',
            dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
            status: 'open'
          }
        ],
        versions: [],
        audit: [],
        reopenedCount: 0,
        externalReportIds: [report.externalReportId]
      };
      appendAudit(
        created,
        '安全运营组',
        '建立案例',
        `离线报告包批次 ${batchId} 首次出现该产品/批号/故障模式组合，外部报告 ${report.externalReportId} 入账并建立案例。`,
        at
      );
      signal = created;
      draft.signals.unshift(created);
    }

    // 全局入账台账 + 批次项状态，与案例写入同一事务提交
    draft.externalLedger.push({
      externalReportId: report.externalReportId,
      caseId: signal.id,
      importBatchId: batchId,
      at
    });
    if (batch) {
      const item = batch.items.find((entry) => entry.externalReportId === report.externalReportId);
      if (item) {
        item.state = 'ingested';
        item.caseId = signal.id;
        item.action = action;
        item.attempts += 1;
        item.error = undefined;
        item.recomputeCaseIds = invalidatedVersions > 0 || action === 'created' ? [signal.id] : item.recomputeCaseIds;
        item.updatedAt = at;
      }
      batch.ingestedCount += 1;
      batch.lastError = undefined;
      batch.updatedAt = at;
    }

    outcome = {
      outcome: 'ingested',
      externalReportId: report.externalReportId,
      caseId: signal.id,
      action,
      invalidatedVersions,
      reopened
    };
  });

  if (outcome?.outcome === 'ingested') {
    // 证据变化的案例排队重算结论（统计已在事务内同步，结论异步恢复）
    enqueueRecompute(outcome.caseId, `外部报告 ${outcome.externalReportId} 入账`, batchId);
  }
  if (!outcome) {
    throw new Error(`报告 ${report.externalReportId} 入账未产生结果`);
  }
  return outcome;
}

function touchDuplicate(
  draft: WorkbenchStateV2,
  batchId: string,
  externalReportId: string,
  firstIngestedBy: string
) {
  const batch = draft.importBatches.find((item) => item.id === batchId);
  const at = now();
  if (batch) {
    // 同一报告号可能在一个离线包内被重复导出：标记该号的全部未完成条目
    const pendingItems = batch.items.filter(
      (entry) => entry.externalReportId === externalReportId && entry.state === 'pending'
    );
    for (const item of pendingItems) {
      item.state = 'duplicate';
      item.attempts += 1;
      item.firstIngestedBy = firstIngestedBy;
      item.updatedAt = at;
      batch.duplicateCount += 1;
    }
    batch.updatedAt = at;
  }
}

/** 记录一条报告接收失败（批次项失败、批次停在未完成处，等待续传） */
export function markIngestFailure(batchId: string, externalReportId: string, error: string) {
  commit((draft) => {
    const batch = draft.importBatches.find((item) => item.id === batchId);
    if (!batch) return;
    const item = batch.items.find((entry) => entry.externalReportId === externalReportId);
    const at = now();
    if (item) {
      item.state = 'failed';
      item.attempts += 1;
      item.error = error;
      item.updatedAt = at;
    }
    batch.failedCount = batch.items.filter((entry) => entry.state === 'failed').length;
    batch.state = 'failed';
    batch.lastError = error;
    batch.updatedAt = at;
    draft.activeImportId = batchId;
  });
}

/* ------------------------------------------------------------------ */
/* 导入批次生命周期 + 可续作执行循环                                      */
/* ------------------------------------------------------------------ */

export function startImport(pkg: {
  id: string;
  name: string;
  region: string;
  reports: ExternalReport[];
}): ImportBatch {
  const at = now();
  const batch: ImportBatch = {
    id: makeId('IMP'),
    packageId: pkg.id,
    packageName: pkg.name,
    region: pkg.region,
    startedAt: at,
    updatedAt: at,
    state: 'in_progress',
    items: pkg.reports.map((report) => ({
      externalReportId: report.externalReportId,
      state: 'pending' as const,
      attempts: 0,
      updatedAt: at
    })),
    reports: structuredClone(pkg.reports),
    ingestedCount: 0,
    duplicateCount: 0,
    failedCount: 0
  };
  commit((draft) => {
    draft.importBatches.unshift(batch);
    draft.activeImportId = batch.id;
  });
  return batch;
}

/** 找到批次中第一条未完成项（pending / failed），实现“从未完成处重试” */
function nextUnfinishedItem(batch: ImportBatch): ImportItemState | undefined {
  return batch.items.find((item) => item.state === 'pending' || item.state === 'failed');
}

let pumpingImport = false;
const RECOMPUTE_DELAY_MS = 700;

/**
 * 执行/续跑一个导入批次：按原始顺序逐条处理，遇到第一条失败即停止。
 * 已 ingested / duplicate 的项跳过，因此中断重跑天然幂等、不会重复入账。
 */
export async function runImport(batchId: string, reports: ExternalReport[]): Promise<void> {
  if (pumpingImport) return;
  pumpingImport = true;
  try {
    for (;;) {
      const state = get(internal);
      const batch = state.importBatches.find((item) => item.id === batchId);
      if (!batch) break;
      const item = nextUnfinishedItem(batch);
      if (!item) {
        // 全部项处理完毕（含重复），批次完成
        commit((draft) => {
          const target = draft.importBatches.find((entry) => entry.id === batchId);
          if (!target) return;
          target.state = 'completed';
          target.completedAt = now();
          target.updatedAt = now();
          target.failedCount = 0;
          target.lastError = undefined;
          if (draft.activeImportId === batchId) draft.activeImportId = null;
        });
        break;
      }
      const report = reports.find((entry) => entry.externalReportId === item.externalReportId);
      if (!report) {
        markIngestFailure(batchId, item.externalReportId, '报告包中找不到该报告号对应内容');
        break;
      }
      try {
        ingestReport(report, batchId);
      } catch (error) {
        markIngestFailure(batchId, item.externalReportId, error instanceof Error ? error.message : String(error));
        break;
      }
      // 让出事件循环，使 UI 能逐条刷新进度
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  } finally {
    pumpingImport = false;
  }
}

/**
 * 续跑所有未完成批次（页面重新加载后调用）。
 * 每条批次顺序执行，已入账 / 已判重的项跳过，从第一条 pending/failed 处继续。
 */
export async function resumeUnfinishedImports(): Promise<void> {
  const state = get(internal);
  const unfinished = state.importBatches.filter(
    (batch) => batch.state === 'in_progress' || batch.state === 'failed'
  );
  for (const batch of unfinished) {
    await runImport(batch.id, batch.reports);
  }
}

/* ------------------------------------------------------------------ */
/* 结论重算队列：失效 → 重算中 → 保存成功才恢复 active；失败回退失效态     */
/* ------------------------------------------------------------------ */

export function enqueueRecompute(caseId: string, reason: string, triggerImportId?: string) {
  commit((draft) => {
    const existing = draft.recomputeJobs.find(
      (job) => job.caseId === caseId && (job.state === 'recomputing' || job.state === 'failed')
    );
    if (existing) {
      // 同一案例在重算未保存成功前持续收到证据：不重复排队，仅补充触发原因。
      // 失败态保持失败，当前一轮 pump 停止后由人工“重试保存”统一处理全部新证据。
      if (!existing.reason.includes(reason)) {
        existing.reason = `${existing.reason}；${reason}`;
      }
      return;
    }
    const job: RecomputeJob = {
      id: makeId('RC'),
      caseId,
      reason,
      triggerImportId,
      state: 'recomputing',
      attempts: 0,
      startedAt: now()
    };
    draft.recomputeJobs.unshift(job);
  });
  void pumpRecompute();
}

/** 手动重试某个案例的失败重算（保存成功前结论一直保持失效） */
export function retryRecompute(caseId: string) {
  commit((draft) => {
    const job = draft.recomputeJobs.find(
      (entry) => entry.caseId === caseId && entry.state === 'failed'
    );
    if (job) {
      job.state = 'recomputing';
      job.attempts += 0;
      job.error = undefined;
    }
  });
  void pumpRecompute();
}

/** 页面加载后恢复中断在“重算中”的任务（失败态保持失效，需人工重试） */
export function resumePendingRecomputes() {
  void pumpRecompute();
}

const inFlightRecomputes = new Set<string>();

/**
 * 不同案例的重算相互独立、并发执行；同一案例在保存成功/失败前通过任务合并保证只有一个在途。
 * 保存成功才把新版本置为 active；失败回退为 invalidated，绝不产生半套结论。
 */
async function pumpRecompute() {
  const pending = get(internal).recomputeJobs.filter(
    (job) => job.state === 'recomputing' && !inFlightRecomputes.has(job.caseId)
  );
  await Promise.all(pending.map((job) => processRecomputeJob(job.id, job.caseId, job.reason)));
}

async function processRecomputeJob(jobId: string, caseId: string, reason: string) {
  if (inFlightRecomputes.has(caseId)) return;
  inFlightRecomputes.add(caseId);
  try {
    const state = get(internal);
    const job = state.recomputeJobs.find((entry) => entry.id === jobId);
    const signal = state.signals.find((entry) => entry.id === caseId);
    if (!job || !signal) {
      if (job && !signal) {
        commit((draft) => {
          const target = draft.recomputeJobs.find((entry) => entry.id === jobId);
          if (target) target.state = 'done';
        });
      }
      return;
    }

    // 进入“重算保存中”：旧结论标记 recomputing，UI 明确提示结论暂不可用
    commit((draft) => {
      const target = draft.recomputeJobs.find((entry) => entry.id === jobId);
      if (target) target.attempts += 1;
      const targetCase = draft.signals.find((entry) => entry.id === caseId);
      if (targetCase) {
        for (const version of targetCase.versions) {
          if (version.state === 'invalidated') version.state = 'recomputing';
        }
        appendAudit(
          targetCase,
          '系统',
          '重算开始',
          `证据变化触发结论重算（第 ${(target?.attempts ?? 1)} 次尝试）：${reason}。保存成功前旧结论不恢复。`
        );
      }
    });

    await new Promise((resolve) => setTimeout(resolve, RECOMPUTE_DELAY_MS));

    if (consumeRecomputeFailure(caseId)) {
      commit((draft) => {
        const target = draft.recomputeJobs.find((entry) => entry.id === jobId);
        const targetCase = draft.signals.find((entry) => entry.id === caseId);
        if (target) {
          target.state = 'failed';
          target.error = '重算结论保存失败（模拟），旧结论维持失效，可手动重试。';
        }
        if (targetCase) {
          for (const version of targetCase.versions) {
            if (version.state === 'recomputing') version.state = 'invalidated';
          }
          appendAudit(
            targetCase,
            '系统',
            '重算失败',
            '重算结论保存失败，已回退为失效状态，批次统计与总览保持新证据口径，等待重试。'
          );
        }
      });
      // 该案例停在未完成处（失败态），其他案例的并发重算不受影响
      return;
    }

    // 成功：重算结果落库，新版本生效，旧版本永久保留并标记被取代
    const current = get(internal).signals.find((entry) => entry.id === caseId);
    if (!current) return;
    const result = recomputeConclusion(current);
    commit((draft) => {
      const targetCase = draft.signals.find((entry) => entry.id === caseId);
      const targetJob = draft.recomputeJobs.find((entry) => entry.id === jobId);
      if (!targetCase || !targetJob) return;
      const newVersion = buildRecomputedVersion(targetCase, result, '系统重算', now(), makeId);
      for (const version of targetCase.versions) {
        if (version.state === 'recomputing' || version.state === 'invalidated') {
          version.state = 'invalidated';
          version.supersededBy = newVersion.id;
        }
      }
      targetCase.versions.unshift(newVersion);
      targetCase.riskLevel = result.riskLevel;
      targetCase.updatedAt = newVersion.createdAt;
      appendAudit(
        targetCase,
        '系统',
        '重算结论生效',
        `重算保存成功，新版本 V${newVersion.version} 恢复生效（${result.disposition === 'corrective_action' ? '纠正措施' : result.disposition === 'risk_communication' ? '风险沟通' : '继续观察'}），旧版本保留并标记失效。`
      );
      targetJob.state = 'done';
      targetJob.finishedAt = now();
      targetJob.newVersion = newVersion.version;
    });
  } finally {
    inFlightRecomputes.delete(caseId);
  }
}

/* ------------------------------------------------------------------ */
/* 人工台账操作（与导入链路共用同一套结论失效/重算语义）                    */
/* ------------------------------------------------------------------ */

export function addEvidenceToCase(caseId: string, evidence: EvidenceItem, actor: string) {
  commit((draft) => {
    const signal = draft.signals.find((entry) => entry.id === caseId);
    if (!signal) return;
    signal.evidence.unshift(evidence);
    if (evidence.batch && !signal.affectedBatches.includes(evidence.batch)) {
      signal.affectedBatches.push(evidence.batch);
    }
    const invalidated = invalidateConclusions(
      signal,
      `人工补充证据「${evidence.title}」，证据矩阵发生变化`,
      now()
    );
    appendAudit(
      signal,
      actor,
      '新增证据',
      `${evidence.title}，证据强度：${evidence.strength}${invalidated ? `；${invalidated} 个旧结论失效待重算` : ''}`
    );
  });
  enqueueRecompute(caseId, `人工补充证据 ${evidence.title}`);
}

export function addVersionToCase(caseId: string, version: CaseVersion, actor: string) {
  commit((draft) => {
    const signal = draft.signals.find((entry) => entry.id === caseId);
    if (!signal) return;
    version.state = 'active';
    for (const old of signal.versions) {
      if (old.state === 'active' || old.state === 'recomputing') {
        old.state = 'invalidated';
        old.supersededBy = version.id;
        old.invalidatedReason ??= `人工形成 V${version.version} 取代旧结论`;
        old.invalidatedAt ??= now();
      }
    }
    signal.versions.unshift(version);
    appendAudit(signal, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
    // 人工版本即最新生效结论，取消该案例尚未完成的重算任务
    for (const job of draft.recomputeJobs) {
      if (job.caseId === caseId && job.state === 'recomputing') {
        job.state = 'done';
        job.finishedAt = now();
      }
    }
  });
}

export function transitionCase(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  commit((draft) => {
    const signal = draft.signals.find((entry) => entry.id === id);
    if (!signal) return;
    const previous = signal.status;
    signal.status = nextStatus;
    if (nextStatus === 'action_required' && signal.riskLevel === 'low') signal.riskLevel = 'medium';
    appendAudit(signal, actor, '状态流转', `${labels[previous]} -> ${labels[nextStatus]}；依据：${reason}`);
  });
}

export function reopenCase(id: string, actor: string, reason: string) {
  commit((draft) => {
    const signal = draft.signals.find((entry) => entry.id === id);
    if (!signal) return;
    signal.status = 'investigating';
    signal.reopenedCount += 1;
    appendAudit(signal, actor, '重新打开', reason);
  });
}

export function replaceTaskInCase(id: string, task: InvestigationTask) {
  commit((draft) => {
    const signal = draft.signals.find((entry) => entry.id === id);
    if (!signal) return;
    signal.tasks = signal.tasks.map((item) => (item.id === task.id ? task : item));
    appendAudit(signal, task.owner, '更新任务', `${task.title}：${task.status}`);
  });
}

export function addAuditEntry(id: string, entry: AuditEntry) {
  commit((draft) => {
    const signal = draft.signals.find((entry2) => entry2.id === id);
    if (!signal) return;
    signal.audit.unshift(entry);
    signal.updatedAt = entry.createdAt;
  });
}

export function addCase(signal: SignalCase) {
  commit((draft) => {
    signal.externalReportIds ??= [];
    for (const version of signal.versions) version.state ??= 'active';
    draft.signals.unshift(signal);
  });
}

export function resetWorkbench() {
  internal.set(seedState());
}

export const workbench = {
  subscribe: internal.subscribe,
  getState: () => get(internal)
};

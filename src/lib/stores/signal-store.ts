import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  ConclusionState,
  EvidenceItem,
  InvestigationTask,
  RiskLevel,
  SignalCase,
  SignalSourceType,
  SignalStatus
} from '$lib/models/signal';
import type {
  ExternalReportInput,
  ImportEvent,
  ImportItemState,
  ImportRun,
  ReportPackageInput
} from '$lib/models/report-package';
import { seedSignals } from '$lib/services/seed';
import { normalizeFailureMode } from '$lib/services/failure-mode';
import { invalidateConclusions, recomputeCase, regenerateVersion } from '$lib/services/recompute';
import {
  persistDb,
  persistFault,
  readRaw,
  removeKey,
  STORAGE_KEY_DB,
  STORAGE_KEY_V1,
  STORAGE_KEY_V1_BACKUP,
  writeRaw
} from '$lib/services/persistence';
import { get, writable } from 'svelte/store';

interface SafetyDb {
  version: 2;
  signals: SignalCase[];
  importRuns: ImportRun[];
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 8)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  return labels[status];
}

// ---------------------------------------------------------------------------
// 旧版本（v1）浏览器数据升级：保留原审计，补外部报告标识，继续参与计算
// ---------------------------------------------------------------------------

function migrateV1Signal(raw: Record<string, unknown>, index: number): SignalCase {
  const signal = structuredClone(raw) as unknown as SignalCase;
  const failure = normalizeFailureMode(
    String(raw.failureMode ?? raw.title ?? '未知故障模式')
  );

  signal.failureMode = String(raw.failureMode ?? failure.code);
  signal.failureModeLabel = String(raw.failureModeLabel ?? failure.label);
  signal.externalReportIds = Array.isArray(raw.externalReportIds)
    ? (raw.externalReportIds as string[])
    : [];

  // 旧证据中来自投诉/维修/不良事件/现场报告的，补外部报告标识（稳定可复算），
  // 使旧数据在升级后继续参与幂等去重与统计计算；测试/文献不视为外部报告。
  signal.evidence = (signal.evidence ?? []).map((evidence) => {
    const next = { ...evidence };
    if (!next.externalReportId && next.type !== 'test' && next.type !== 'literature') {
      next.externalReportId = `LEGACY-${signal.id}-${next.id}`;
      if (!signal.externalReportIds.includes(next.externalReportId)) {
        signal.externalReportIds.push(next.externalReportId);
      }
    }
    return next;
  });

  signal.versions = (signal.versions ?? []).map((version) => ({
    ...version,
    state: (version as CaseVersion).state ?? ('active' as ConclusionState),
    kind: (version as CaseVersion).kind ?? 'manual'
  }));

  signal.audit = signal.audit ?? [];
  signal.tasks = signal.tasks ?? [];
  signal.affectedBatches = signal.affectedBatches ?? [String(raw.batch ?? '')];
  signal.recomputePending = false;

  // 升级动作只新增一条审计，原有审计原样保留
  signal.audit = [
    {
      id: makeId('AUD'),
      actor: '系统迁移',
      action: '数据升级',
      detail: `浏览器旧版台账升级为 v2：保留原审计 ${signal.audit.length} 条，补外部报告标识 ${signal.externalReportIds.length} 个，继续参与归并与统计。`,
      createdAt: now()
    },
    ...signal.audit
  ];
  void index;
  return signal;
}

function isV1Shape(raw: unknown): raw is Array<Record<string, unknown>> {
  return (
    Array.isArray(raw) &&
    raw.every((item) => item && typeof item === 'object' && 'id' in item && 'product' in item)
  );
}

function cloneSeedDb(): SafetyDb {
  return { version: 2, signals: structuredClone(seedSignals), importRuns: [] };
}

function buildInitialDb(): SafetyDb {
  if (!browser) return cloneSeedDb();

  const v2 = readRaw(STORAGE_KEY_DB) as SafetyDb | null;
  if (v2 && v2.version === 2 && Array.isArray(v2.signals)) {
    return { version: 2, signals: v2.signals, importRuns: v2.importRuns ?? [] };
  }

  const legacy = readRaw(STORAGE_KEY_V1);
  if (isV1Shape(legacy)) {
    const signals = legacy.map((raw, index) => migrateV1Signal(raw, index));
    // 原 v1 数据留备份，再切换到 v2 键
    writeRaw(STORAGE_KEY_V1_BACKUP, legacy);
    const db: SafetyDb = { version: 2, signals, importRuns: [] };
    try {
      persistDb(db);
      removeKey(STORAGE_KEY_V1);
    } catch {
      // 升级写入失败时本次会话仍使用已迁移的内存数据，下次打开重试升级
    }
    return db;
  }

  return cloneSeedDb();
}

const internal = writable<SafetyDb>(buildInitialDb());

/**
 * 原子提交：在内存里构造完整新状态 → 校验 → 一次性持久化 → 发布。
 * 持久化抛错时内存状态不变，绝不留下半套案例。
 */
function commitDb(mutate: (draft: SafetyDb) => void): SafetyDb {
  const current = get(internal);
  const draft: SafetyDb = structuredClone(current);
  mutate(draft);
  if (draft.version !== 2 || !Array.isArray(draft.signals) || !Array.isArray(draft.importRuns)) {
    throw new Error('提交数据结构不完整，已拒绝写入');
  }
  persistDb(draft); // 模拟故障或序列化失败时抛错，下面的 set 不会执行
  internal.set(draft);
  return draft;
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  const entry: AuditEntry = { id: makeId('AUD'), actor, action, detail, createdAt: now() };
  signal.audit.unshift(entry);
  signal.updatedAt = now();
  return entry;
}

function nextSignalId(signals: SignalCase[]): string {
  const year = new Date().getFullYear();
  let max = 20;
  for (const signal of signals) {
    const match = /^SIG-\d{4}-(\d+)$/.exec(signal.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `SIG-${year}-${String(max + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// 信号 store（保持与旧版 signalStore 同名接口）
// ---------------------------------------------------------------------------

const signalsStore = writable<SignalCase[]>(get(internal).signals);
internal.subscribe((db) => signalsStore.set(db.signals));

export const importRunsStore = writable<ImportRun[]>(get(internal).importRuns);
internal.subscribe((db) => importRunsStore.set(db.importRuns));

export const signalStore = {
  subscribe: signalsStore.subscribe,

  add(signal: SignalCase) {
    commitDb((draft) => {
      draft.signals = [signal, ...draft.signals];
    });
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: '',
      openedAt: createdAt,
      updatedAt: createdAt,
      reopenedCount: 0,
      audit: []
    };
    signal.id = nextSignalId(get(internal).signals);
    signal.audit = [
      {
        id: makeId('AUD'),
        actor: input.owner,
        action: '建立信号',
        detail: `按${input.sourceType}来源建立核查任务。`,
        createdAt
      }
    ];
    commitDb((draft) => {
      draft.signals = [signal, ...draft.signals];
    });
    return signal;
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    commitDb((draft) => {
      const signal = draft.signals.find((item) => item.id === id);
      if (!signal) return;
      const previous = signal.status;
      signal.status = nextStatus;
      if (nextStatus === 'action_required' && signal.riskLevel === 'low') {
        signal.riskLevel = 'medium';
      }
      appendAudit(
        signal,
        actor,
        '状态流转',
        `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
      );
    });
  },

  /**
   * 人工补充证据：证据并入矩阵后，受影响案例旧结论在同一事务内失效并重算，
   * 批次统计同步更新；持久化失败则整体不生效，可重试。
   */
  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    const current = get(internal).signals.find((item) => item.id === id);
    if (!current) throw new Error('未找到目标信号');

    // 待重算案例收到人工证据：带新证据一次重算到位并恢复结论
    const { signal } = recomputeCase(current, {
      newEvidence: [evidence],
      reason: `人工补录证据：${evidence.title}`,
      actor,
      isReport: false
    });

    commitDb((draft) => {
      const index = draft.signals.findIndex((item) => item.id === id);
      if (index >= 0) draft.signals[index] = signal;
    });
  },

  /** 人工形成结论版本：旧 active 版本置为 superseded，新版本立即生效 */
  addVersion(id: string, version: CaseVersion, actor: string) {
    commitDb((draft) => {
      const signal = draft.signals.find((item) => item.id === id);
      if (!signal) return;
      for (const existing of signal.versions) {
        if (existing.state === 'active' || existing.state === 'pending_recompute') {
          existing.state = 'invalidated';
          existing.invalidatedReason = `人工形成 V${version.version}`;
          existing.invalidatedAt = now();
        }
      }
      const manualVersion: CaseVersion = { ...version, state: 'active', kind: 'manual' };
      signal.versions = [manualVersion, ...signal.versions];
      signal.recomputePending = false;
      signal.recomputeReason = undefined;
      appendAudit(signal, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
    });
  },

  /** 对待重算案例手动触发重算（也被断点续传复用） */
  recompute(id: string, actor: string, reason: string) {
    const current = get(internal).signals.find((item) => item.id === id);
    if (!current) throw new Error('未找到目标信号');
    const { signal } = regenerateVersion(current, reason, actor);
    commitDb((draft) => {
      const index = draft.signals.findIndex((item) => item.id === id);
      if (index >= 0) draft.signals[index] = signal;
    });
  },

  reopen(id: string, actor: string, reason: string) {
    commitDb((draft) => {
      const signal = draft.signals.find((item) => item.id === id);
      if (!signal) return;
      signal.status = 'investigating';
      signal.reopenedCount += 1;
      appendAudit(signal, actor, '重新打开', reason);
    });
  },

  replaceTask(id: string, task: InvestigationTask) {
    commitDb((draft) => {
      const signal = draft.signals.find((item) => item.id === id);
      if (!signal) return;
      signal.tasks = signal.tasks.map((item) => (item.id === task.id ? task : item));
      appendAudit(signal, task.owner, '更新任务', `${task.title}：${task.status}`);
    });
  },

  addAudit(id: string, entry: AuditEntry) {
    commitDb((draft) => {
      const signal = draft.signals.find((item) => item.id === id);
      if (!signal) return;
      signal.audit.unshift(entry);
      signal.updatedAt = entry.createdAt;
    });
  },

  reset() {
    const fresh = cloneSeedDb();
    internal.set(fresh);
    if (browser) persistDb(fresh);
  },

  getSnapshot() {
    return get(internal).signals;
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  const failure = normalizeFailureMode(input.title);
  return {
    id: nextSignalId(get(internal).signals),
    title: input.title,
    product: input.product,
    batch: input.batch,
    failureMode: failure.code,
    failureModeLabel: failure.label,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 0,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0,
    externalReportIds: [],
    recomputePending: false
  };
}

// ---------------------------------------------------------------------------
// 离线报告包导入：幂等入账 + 归并/建案 + 断点续作 + 失效重算
// ---------------------------------------------------------------------------

const ACTOR_IMPORT = '安全台账（离线报告包）';

function evidenceFromReport(report: ExternalReportInput, run: ImportRun): EvidenceItem {
  return {
    id: makeId('E'),
    type: report.type,
    title: report.title,
    source: report.source,
    strength: report.strength,
    batch: report.batch,
    note: report.description,
    createdAt: now(),
    externalReportId: report.externalReportId,
    importBatchId: run.packageId
  };
}

function occurrenceRateFor(reportCount: number, exposedUnits: number): number {
  return exposedUnits > 0 ? +((reportCount / exposedUnits) * 100).toFixed(2) : 0;
}

function buildNewCase(report: ExternalReportInput, run: ImportRun, evidence: EvidenceItem): SignalCase {
  const failure = normalizeFailureMode(report.failureMode);
  const ts = now();
  const rate = occurrenceRateFor(1, report.exposedUnits);
  return {
    id: '',
    title: `${failure.label}：${report.product} / ${report.batch}`,
    product: report.product,
    batch: report.batch,
    failureMode: failure.code,
    failureModeLabel: failure.label,
    sourceType: report.type,
    status: 'new',
    riskLevel: riskFromSeverity(report.severity),
    severity: report.severity,
    reportCount: 1,
    exposedUnits: report.exposedUnits,
    occurrenceRate: rate,
    occurredAt: report.occurredAt,
    openedAt: ts,
    updatedAt: ts,
    owner: '待分派',
    description: report.description,
    affectedBatches: [report.batch],
    evidence: [evidence],
    tasks: [
      {
        id: makeId('TASK'),
        title: `核对${failure.label}外部报告与现场记录`,
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: ACTOR_IMPORT,
        action: '外部报告入账',
        detail: `离线报告包 ${run.packageId} 首次引入该产品/批号/故障模式，建立新案例（报告号 ${report.externalReportId}）。`,
        createdAt: ts,
        externalReportId: report.externalReportId,
        importBatchId: run.packageId
      }
    ],
    reopenedCount: 0,
    externalReportIds: [report.externalReportId],
    recomputePending: true,
    recomputeReason: `外部报告 ${report.externalReportId} 到达（报告包 ${run.packageId}），等待自动重算结论`
  };
}

function findCaseForReport(db: SafetyDb, report: ExternalReportInput): SignalCase | undefined {
  const failure = normalizeFailureMode(report.failureMode);
  return db.signals.find(
    (signal) =>
      signal.product.trim().toLowerCase() === report.product.trim().toLowerCase() &&
      signal.batch.trim().toLowerCase() === report.batch.trim().toLowerCase() &&
      signal.failureMode === failure.code
  );
}

function isDuplicate(db: SafetyDb, externalReportId: string): SignalCase | undefined {
  return db.signals.find((signal) => signal.externalReportIds.includes(externalReportId));
}

export function startImport(pkg: ReportPackageInput, failOnceStage?: ImportRun['failOnceStage']): ImportRun {
  const ts = now();
  const run: ImportRun = {
    id: makeId('RUN'),
    packageId: pkg.packageId,
    exportedAt: pkg.exportedAt,
    team: pkg.team,
    reports: pkg.reports,
    startedAt: ts,
    updatedAt: ts,
    status: 'running',
    cursor: 0,
    items: pkg.reports.map((report) => ({
      externalReportId: report.externalReportId,
      attempts: 0
    })),
    events: [
      {
        at: ts,
        stage: 'start',
        message: `报告包 ${pkg.packageId}（${pkg.team}）开始接收，共 ${pkg.reports.length} 条报告。`
      }
    ],
    failOnceStage,
    affectedSignalIds: []
  };
  commitDb((draft) => {
    draft.importRuns.unshift(run);
  });
  return run;
}

function updateRun(runId: string, mutate: (run: ImportRun) => void) {
  commitDb((draft) => {
    const run = draft.importRuns.find((item) => item.id === runId);
    if (!run) return;
    mutate(run);
    run.updatedAt = now();
  });
}

function pushEvent(run: ImportRun, stage: string, message: string, extra?: Partial<ImportEvent>) {
  const event: ImportEvent = { at: now(), stage, message, ...extra };
  run.events.push(event);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * 处理（或续作）一个导入运行。
 *
 * 每条报告分两个持久化阶段，保证失败可从断点继续：
 *  1. receive：幂等检查 + 建案/归并入账（证据、统计、外部报告号）+ 旧结论失效；原子提交
 *  2. recompute：重算统计与新结论版本，成功保存后结论才恢复 active；原子提交
 *
 * 阶段 1 失败：什么都不写入，游标不动；
 * 阶段 2 失败：报告已入账、旧结论保持失效（pending_recompute），从该报告重算处继续；
 * 持久化失败：原子提交整体放弃，无半套案例。
 */
export async function processImportRun(runId: string): Promise<ImportRun> {
  const first = get(internal).importRuns.find((item) => item.id === runId);
  if (!first) throw new Error('导入批次不存在');
  if (first.status === 'completed') return first;

  // 故障注入只在首次处理时触发一次
  const injectedStage = first.failOnceStage;

  while (true) {
    const live = get(internal).importRuns.find((item) => item.id === runId)!;
    const index = live.cursor;
    if (index >= live.reports.length) break;

    const report = live.reports[index];
    const item = live.items[index];
    const failure = normalizeFailureMode(report.failureMode);
    const reasonText = `外部报告 ${report.externalReportId} 到达（报告包 ${live.packageId}）`;

    // 阶段 2 续作：上一轮已入账失效，只需重算保存
    const phase2Resume =
      item.phase === 'recompute' &&
      item.signalId !== undefined &&
      isDuplicate(get(internal), report.externalReportId) !== undefined;

    if (!phase2Resume) {
      await wait(120);

      // —— 幂等：同一外部报告号只入账一次（含跨报告包、断点重放）——
      if (isDuplicate(get(internal), report.externalReportId)) {
        commitDb((draft) => {
          const r = draft.importRuns.find((x) => x.id === runId)!;
          const holder = draft.signals.find((s) =>
            s.externalReportIds.includes(report.externalReportId)
          );
          r.items[index] = {
            ...r.items[index],
            outcome: 'duplicate',
            phase: undefined,
            error: undefined,
            signalId: holder?.id ?? r.items[index].signalId,
            attempts: r.items[index].attempts + 1
          };
          r.cursor = index + 1;
          pushEvent(
            r,
            'duplicate',
            `报告号 ${report.externalReportId} 已入账于 ${holder?.id ?? '历史案例'}，跳过重复导入。`,
            { externalReportId: report.externalReportId, signalId: holder?.id }
          );
        });
        continue;
      }

      // —— 阶段 0：模拟接收失败（写入前）——
      if (injectedStage === 'receive') {
        const error = new Error(
          `接收报告 ${report.externalReportId} 失败：内网通道中断（演示），任何内容均未写入。`
        );
        markRunFailed(runId, index, 'receive', error.message, report.externalReportId);
        throw error;
      }

      // —— 阶段 1：入账 + 旧结论失效（原子提交）——
      if (injectedStage === 'persist') {
        persistFault.failNextPersist = true;
        persistFault.reason = `持久化失败（演示）：报告 ${report.externalReportId} 的入账未写入任何数据。`;
      }

      try {
        commitDb((draft) => {
          const r = draft.importRuns.find((x) => x.id === runId)!;
          const evidence = evidenceFromReport(report, r);
          const existing = findCaseForReport(draft, report);
          let targetId: string;

          if (existing) {
            existing.evidence.unshift(evidence);
            if (!existing.affectedBatches.includes(report.batch)) {
              existing.affectedBatches.push(report.batch);
            }
            existing.severity = Math.max(existing.severity, report.severity);
            existing.riskLevel = riskFromSeverity(existing.severity);
            existing.exposedUnits += report.exposedUnits;
            existing.reportCount += 1;
            existing.occurrenceRate = occurrenceRateFor(existing.reportCount, existing.exposedUnits);
            existing.externalReportIds.push(report.externalReportId);
            const mergedEntry = appendAudit(
              existing,
              ACTOR_IMPORT,
              '外部报告归并',
              `按产品 ${report.product}、批号 ${report.batch}、故障模式 ${failure.label} 归并报告 ${report.externalReportId}；批次统计已同步。`
            );
            mergedEntry.externalReportId = report.externalReportId;
            mergedEntry.importBatchId = r.packageId;
            Object.assign(existing, invalidateConclusions(existing, reasonText, ACTOR_IMPORT));
            targetId = existing.id;
          } else {
            const created = buildNewCase(report, r, evidence);
            created.id = nextSignalId(draft.signals);
            draft.signals.unshift(created);
            targetId = created.id;
          }

          if (!r.affectedSignalIds.includes(targetId)) r.affectedSignalIds.push(targetId);
          r.items[index] = {
            ...r.items[index],
            outcome: existing ? 'merged' : 'created',
            phase: 'recompute',
            signalId: targetId,
            failureMode: failure.code,
            error: undefined,
            attempts: r.items[index].attempts + 1
          };
          pushEvent(
            r,
            'receive',
            `报告 ${report.externalReportId} 已${existing ? '归并' : '建立案例'} ${targetId}，旧结论失效，等待重算保存。`,
            { externalReportId: report.externalReportId, signalId: targetId }
          );
        });
      } catch (error) {
        // 原子提交失败：没有任何内容写入；记录批次失败态（游标不动，可整体重试）
        const message =
          error instanceof Error
            ? error.message
            : `报告 ${report.externalReportId} 入账时持久化失败。`;
        markRunFailed(runId, index, 'receive', message, report.externalReportId);
        throw new Error(message);
      }
    }

    // —— 阶段 2：重算并保存新结论，保存成功才恢复 active ——
    const live2 = get(internal).importRuns.find((item) => item.id === runId)!;
    const phaseItem = live2.items[index];

    if (injectedStage === 'recompute' && phaseItem.attempts <= 1 && !phase2Resume) {
      const error = new Error(
        `报告 ${report.externalReportId} 已入账，但结论重算保存失败（演示）。案例保持“待重算”，可从断点重试。`
      );
      markRunFailed(runId, index, 'recompute', error.message, report.externalReportId);
      throw error;
    }

    const target = get(internal).signals.find((s) => s.id === phaseItem.signalId);
    if (!target) {
      const message = `重算时未找到案例 ${phaseItem.signalId ?? ''}`;
      markRunFailed(runId, index, 'recompute', message, report.externalReportId);
      throw new Error(message);
    }

    try {
      const regenerated = regenerateVersion(target, reasonText, ACTOR_IMPORT).signal;
      commitDb((draft) => {
        const signalIndex = draft.signals.findIndex((s) => s.id === target.id);
        if (signalIndex >= 0) draft.signals[signalIndex] = regenerated;

        const r = draft.importRuns.find((x) => x.id === runId)!;
        r.items[index] = {
          ...r.items[index],
          phase: undefined,
          error: undefined,
          attempts: r.items[index].attempts + (phase2Resume ? 1 : 0)
        };
        r.cursor = index + 1;
        pushEvent(
          r,
          'recompute',
          `案例 ${target.id} 新结论 V${regenerated.versions[0]?.version} 保存成功并恢复有效，批次统计/总览/审计同步更新。`,
          { externalReportId: report.externalReportId, signalId: target.id }
        );
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `报告 ${report.externalReportId} 重算结果保存失败。`;
      markRunFailed(runId, index, 'recompute', message, report.externalReportId);
      throw new Error(message);
    }
  }

  // —— 全部完成 ——
  updateRun(runId, (r) => {
    r.status = 'completed';
    r.cursor = r.reports.length;
    r.failOnceStage = undefined;
    r.finishedAt = now();
    pushEvent(
      r,
      'complete',
      `报告包接收完成：${r.items.filter((x) => x.outcome === 'created').length} 条建案、` +
        `${r.items.filter((x) => x.outcome === 'merged').length} 条归并、` +
        `${r.items.filter((x) => x.outcome === 'duplicate').length} 条重复跳过。`
    );
  });

  return get(internal).importRuns.find((item) => item.id === runId)!;
}

function markRunFailed(
  runId: string,
  index: number,
  phase: 'receive' | 'recompute',
  message: string,
  externalReportId?: string
) {
  try {
    commitDb((draft) => {
      const r = draft.importRuns.find((x) => x.id === runId);
      if (!r) return;
      r.status = 'failed';
      r.error = message;
      r.failOnceStage = undefined; // 故障仅触发一次，续作不再注入
      if (r.items[index]) {
        r.items[index] = { ...r.items[index], phase, error: message };
      }
      pushEvent(r, 'failed', message, { externalReportId });
    });
  } catch {
    // 记录失败态本身也无法持久化时，界面仍可基于内存状态重试
  }
}

/** 手动重试入口：清除失败态后从游标继续 */
export async function resumeImportRun(runId: string): Promise<ImportRun> {
  updateRun(runId, (r) => {
    if (r.status !== 'failed') return;
    r.status = 'running';
    r.error = undefined;
    pushEvent(r, 'resume', `从未完成处（第 ${r.cursor + 1} 条）续作接收。`);
  });
  return processImportRun(runId);
}

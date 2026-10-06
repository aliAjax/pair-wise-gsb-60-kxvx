import type {
  AuditEntry,
  CaseVersion,
  ConclusionState,
  Disposition,
  EvidenceItem,
  RiskLevel,
  SignalCase
} from '$lib/models/signal';

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

export interface RecomputeInput {
  /** 新并入的外部报告证据（已构造好，待加入矩阵） */
  newEvidence?: EvidenceItem[];
  /** 新并入的严重度，用于抬升案例严重度（外部报告入账时提供） */
  newSeverity?: number;
  /** 新并入报告的暴露台数，累加到案例 */
  addedExposedUnits?: number;
  /** 新并入批号（可能扩展 affectedBatches） */
  addedBatch?: string;
  /** 新证据是否为外部报告（是才累加报告计数；人工补录证据不计数） */
  isReport?: boolean;
  /** 触发原因，写入审计与版本依据，例如外部报告号 */
  reason: string;
  /** 审计操作人 */
  actor: string;
  /** 入账时间（测试可控） */
  at?: string;
}

export interface RecomputeResult {
  signal: SignalCase;
  /** 本次失效的旧版本（state 已置为 invalidated） */
  invalidatedVersions: CaseVersion[];
  /** 本次生成的新版本（可能为空：无证据变化时不重算） */
  newVersion: CaseVersion | null;
}

/**
 * 重算规则（确定性）：
 * - 严重度取全部报告最大值，风险等级随之重算
 * - 报告数按新增证据条数累加；批号并集扩展
 * - 发生率 = 报告数 / 暴露台数 × 100
 * - 强支持证据 ≥2 或严重度 5 → 纠正措施；强支持 ≥1 或发生率 ≥0.75 → 风险沟通；否则继续观察
 *
 * 语义保证：旧结论先失效，重算版本在同一结果对象内生成；
 * 调用方必须在同一次持久化里保存成功，结论才从 pending_recompute 恢复为 active。
 */
export function recomputeCase(base: SignalCase, input: RecomputeInput): RecomputeResult {
  const at = input.at ?? now();
  const signal: SignalCase = structuredClone(base);

  // 1. 并入新证据 / 批号 / 统计
  if (input.newEvidence?.length) {
    signal.evidence = [...input.newEvidence, ...signal.evidence];
    for (const evidence of input.newEvidence) {
      if (evidence.batch && !signal.affectedBatches.includes(evidence.batch)) {
        signal.affectedBatches.push(evidence.batch);
      }
    }
  }
  if (input.addedBatch && !signal.affectedBatches.includes(input.addedBatch)) {
    signal.affectedBatches.push(input.addedBatch);
  }
  if (typeof input.newSeverity === 'number') {
    signal.severity = Math.max(signal.severity, input.newSeverity);
  }
  if (input.addedExposedUnits) {
    signal.exposedUnits += input.addedExposedUnits;
  }
  if (input.isReport) {
    signal.reportCount += input.newEvidence?.length ?? 0;
  }
  signal.riskLevel = riskFromSeverity(signal.severity);
  signal.occurrenceRate =
    signal.exposedUnits > 0 ? +(signal.reportCount / signal.exposedUnits * 100).toFixed(2) : 0;

  // 2. 旧结论失效（仅失效当前 active 版本；历史版本保留为 superseded/invalidated 记录）
  const invalidatedVersions: CaseVersion[] = [];
  for (const version of signal.versions) {
    if (version.state === 'active') {
      version.state = 'invalidated';
      version.invalidatedReason = input.reason;
      version.invalidatedAt = at;
      invalidatedVersions.push(version);
    }
  }

  // 3. 重算新版本
  const evidence = signal.evidence;
  const strongCount = evidence.filter((item) => item.strength === 'strong').length;
  const contraryCount = evidence.filter((item) => item.strength === 'contrary').length;

  let disposition: Disposition = 'continue_observation';
  if (signal.severity >= 5 || strongCount >= 2) {
    disposition = 'corrective_action';
  } else if (strongCount >= 1 || signal.occurrenceRate >= 0.75) {
    disposition = 'risk_communication';
  }

  const dispositionLabel: Record<Disposition, string> = {
    continue_observation: '继续观察',
    risk_communication: '风险沟通',
    corrective_action: '纠正措施'
  };

  const rationaleParts = [
    `证据矩阵共 ${evidence.length} 项（强支持 ${strongCount}、相反 ${contraryCount}）`,
    `重算发生率 ${signal.occurrenceRate.toFixed(2)}%（${signal.reportCount} 条 / ${signal.exposedUnits} 台）`,
    `严重度 ${signal.severity}`,
    `触发原因：${input.reason}`
  ];

  const newVersion: CaseVersion = {
    id: makeId('V'),
    version: (signal.versions[0]?.version ?? 0) + 1,
    author: input.actor,
    summary: `新证据到达后自动重算：建议${dispositionLabel[disposition]}（${signal.failureModeLabel}，覆盖批号 ${signal.affectedBatches.length} 个）`,
    disposition,
    rationale: rationaleParts.join('；'),
    createdAt: at,
    state: 'active',
    kind: 'auto'
  };
  signal.versions = [newVersion, ...signal.versions];

  // 4. 审计同步追加（失效 + 重算两条，和案例在同一持久化单元）
  const audits: AuditEntry[] = [];
  if (invalidatedVersions.length) {
    audits.push({
      id: makeId('AUD'),
      actor: input.actor,
      action: '结论失效',
      detail: `因${input.reason}，V${invalidatedVersions.map((v) => v.version).join('、V')} 旧结论失效并触发重算。`,
      createdAt: at,
      ...(input.newEvidence?.[0]?.externalReportId
        ? { externalReportId: input.newEvidence[0].externalReportId }
        : {}),
      ...(input.newEvidence?.[0]?.importBatchId
        ? { importBatchId: input.newEvidence[0].importBatchId }
        : {})
    });
  } else {
    audits.push({
      id: makeId('AUD'),
      actor: input.actor,
      action: '结论重算',
      detail: `新案例首次形成自动结论；触发原因：${input.reason}。`,
      createdAt: at,
      ...(input.newEvidence?.[0]?.externalReportId
        ? { externalReportId: input.newEvidence[0].externalReportId }
        : {}),
      ...(input.newEvidence?.[0]?.importBatchId
        ? { importBatchId: input.newEvidence[0].importBatchId }
        : {})
    });
  }
  audits.push({
    id: makeId('AUD'),
    actor: input.actor,
    action: '结论恢复',
    detail: `V${newVersion.version} 重算保存成功，建议${dispositionLabel[disposition]}；批次统计与总览已同步。`,
    createdAt: at,
    ...(input.newEvidence?.[0]?.externalReportId
      ? { externalReportId: input.newEvidence[0].externalReportId }
      : {}),
    ...(input.newEvidence?.[0]?.importBatchId
      ? { importBatchId: input.newEvidence[0].importBatchId }
      : {})
  });
  signal.audit = [...audits, ...signal.audit];

  signal.recomputePending = false;
  signal.recomputeReason = undefined;
  signal.updatedAt = at;

  return { signal, invalidatedVersions, newVersion };
}

/**
 * 仅失效不重算（当重算阶段失败时使用）：旧结论标 invalidated、案例进入 pending_recompute。
 * 不会产生半套案例：证据/统计已经随报告入账，结论保持待重算，可重试。
 */
export function invalidateConclusions(
  base: SignalCase,
  reason: string,
  actor: string,
  at?: string
): SignalCase {
  const ts = at ?? now();
  const signal: SignalCase = structuredClone(base);
  let changed = false;
  for (const version of signal.versions) {
    if (version.state === 'active') {
      version.state = 'invalidated';
      version.invalidatedReason = reason;
      version.invalidatedAt = ts;
      changed = true;
    }
  }
  if (changed || !signal.versions.some((v) => v.state === 'active')) {
    signal.recomputePending = true;
    signal.recomputeReason = reason;
    signal.audit = [
      {
        id: makeId('AUD'),
        actor,
        action: '结论失效待重算',
        detail: `因${reason}旧结论已失效，重算尚未保存成功，可从断点重试。`,
        createdAt: ts
      },
      ...signal.audit
    ];
    signal.updatedAt = ts;
  }
  return signal;
}

/** 只重算并形成新版本（供“从断点重试/手动重算”调用） */
export function regenerateVersion(
  base: SignalCase,
  reason: string,
  actor: string,
  at?: string
): RecomputeResult {
  const ts = at ?? now();
  const signal: SignalCase = structuredClone(base);

  const evidence = signal.evidence;
  const strongCount = evidence.filter((item) => item.strength === 'strong').length;
  const contraryCount = evidence.filter((item) => item.strength === 'contrary').length;

  let disposition: Disposition = 'continue_observation';
  if (signal.severity >= 5 || strongCount >= 2) {
    disposition = 'corrective_action';
  } else if (strongCount >= 1 || signal.occurrenceRate >= 0.75) {
    disposition = 'risk_communication';
  }
  const dispositionLabel: Record<Disposition, string> = {
    continue_observation: '继续观察',
    risk_communication: '风险沟通',
    corrective_action: '纠正措施'
  };

  const newVersion: CaseVersion = {
    id: makeId('V'),
    version: (signal.versions[0]?.version ?? 0) + 1,
    author: actor,
    summary: `重算恢复：建议${dispositionLabel[disposition]}（${signal.failureModeLabel}，覆盖批号 ${signal.affectedBatches.length} 个）`,
    disposition,
    rationale: [
      `证据矩阵共 ${evidence.length} 项（强支持 ${strongCount}、相反 ${contraryCount}）`,
      `重算发生率 ${signal.occurrenceRate.toFixed(2)}%（${signal.reportCount} 条 / ${signal.exposedUnits} 台）`,
      `严重度 ${signal.severity}`,
      `触发原因：${reason}`
    ].join('；'),
    createdAt: ts,
    state: 'active' satisfies ConclusionState,
    kind: 'auto'
  };
  signal.versions = [newVersion, ...signal.versions];
  signal.recomputePending = false;
  signal.recomputeReason = undefined;
  signal.updatedAt = ts;
  signal.audit = [
    {
      id: makeId('AUD'),
      actor,
      action: '结论恢复',
      detail: `V${newVersion.version} 重算保存成功，建议${dispositionLabel[disposition]}；批次统计与总览已同步。`,
      createdAt: ts
    },
    ...signal.audit
  ];

  return { signal, invalidatedVersions: [], newVersion };
}

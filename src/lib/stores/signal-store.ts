import { browser } from '$app/environment';
import { derived, get, type Readable } from 'svelte/store';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  RiskLevel,
  SignalCase,
  SignalStatus
} from '$lib/models/signal';
import { failureModeLabel } from '$lib/models/report-package';
import { seedSignals } from '$lib/services/seed';
import {
  addAuditEntry,
  addCase,
  addEvidenceToCase,
  addVersionToCase,
  makeId,
  now,
  reopenCase,
  replaceTaskInCase,
  resetWorkbench,
  transitionCase,
  workbench
} from './workbench-store';

function cloneSeed(): SignalCase[] {
  return structuredClone(seedSignals);
}

/**
 * 兼容层：v2 起信号案例由 workbench-store 统一在事务内维护
 * （案例 + 入账台账 + 批次项 + 重算任务）。这里对外继续暴露案例数组 store，
 * 让现有页面 / 服务无需关心存储结构变化。
 */
const cases: Readable<SignalCase[]> = derived(workbench, ($workbench) => $workbench.signals);

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

export const signalStore = {
  subscribe: cases.subscribe,

  add(signal: SignalCase) {
    addCase(signal);
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    transitionCase(id, nextStatus, reason, actor);
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    addEvidenceToCase(id, evidence, actor);
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    addVersionToCase(id, version, actor);
  },

  reopen(id: string, actor: string, reason: string) {
    reopenCase(id, actor, reason);
  },

  replaceTask(id: string, task: InvestigationTask) {
    replaceTaskInCase(id, task);
  },

  addAudit(id: string, entry: AuditEntry) {
    addAuditEntry(id, entry);
  },

  reset() {
    resetWorkbench();
  },

  getSnapshot() {
    return get(workbench).signals;
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  failureMode: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  const failureMode = input.failureMode || 'unknown';
  return {
    id: makeId('SIG'),
    title: input.title,
    product: input.product,
    batch: input.batch,
    failureMode,
    failureModeLabel: failureModeLabel(failureMode),
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
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
        detail: '由人工登记表单创建初始信号（尚无外部报告号，后续可与离线报告包归并）。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0,
    externalReportIds: []
  };
}

// 服务器端表单动作不依赖浏览器状态时需要的兜底
export function getSeedSnapshot(): SignalCase[] {
  if (!browser) return cloneSeed();
  return get(workbench).signals;
}

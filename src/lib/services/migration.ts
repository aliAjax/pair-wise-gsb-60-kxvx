import type {
  EvidenceItem,
  SignalCase
} from '$lib/models/signal';
import { failureModeLabel } from '$lib/models/report-package';
import type { WorkbenchStateV2 } from '$lib/models/report-package';

const LEGACY_KEY = 'medical-safety-signals-v1';

/**
 * v1 数据没有故障模式字段。按标题/描述关键词做一次性归类，
 * 无法判断的进入“待归类故障模式”，升级后可人工继续归并。
 */
function inferFailureMode(signal: SignalCase): string {
  const text = `${signal.title} ${signal.description} ${signal.evidence
    .map((item) => `${item.title} ${item.note}`)
    .join(' ')}`;
  if (/阻塞|压力|堵塞/.test(text)) return 'occlusion_alarm';
  if (/电池|续航|容量|充电.*时间/.test(text)) return 'battery_capacity';
  if (/温升|过热|温度|焊接/.test(text)) return 'thermal_overheat';
  if (/测量|偏差|缩放|坐标/.test(text)) return 'measurement_deviation';
  if (/外壳|锁扣|断裂|结构/.test(text)) return 'housing_damage';
  return 'unknown';
}

/**
 * 从证据来源/标题中提取已有的外部报告号（如 R-9081、AE-260921、F-771）。
 * 提取不到的旧外部类证据，按 LEGACY-<案例号短码>-<序号> 生成稳定标识，
 * 保证升级后仍可参与全局幂等计算。
 */
const SOURCE_NUMBER_PATTERN = /\b([A-Z]{1,3}-?\d[\w-]*)\b/;

function extractExternalId(evidence: EvidenceItem, caseId: string, index: number): string | undefined {
  // 测试/文献证据不是外部报告，不进入报告台账
  if (evidence.type === 'test' || evidence.type === 'literature') return undefined;

  const fromSource = SOURCE_NUMBER_PATTERN.exec(evidence.source)?.[1];
  if (fromSource) return fromSource;
  const fromTitle = SOURCE_NUMBER_PATTERN.exec(evidence.title)?.[1];
  if (fromTitle) return fromTitle;

  const caseShort = caseId.replace(/^SIG-\d{4}-/, '');
  return `LEGACY-${caseShort}-${String(index + 1).padStart(2, '0')}`;
}

function isAlreadyV2(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as WorkbenchStateV2).schemaVersion === 2
  );
}

/** 旧浏览器的 v1 数据是否存在（用于 UI 提示“已升级保留原审计”） */
export function legacyV1Present(storage: Storage): boolean {
  try {
    const raw = storage.getItem(LEGACY_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && !isAlreadyV2(parsed);
  } catch {
    return false;
  }
}

/**
 * 将 v1（SignalCase[]）就地升级为 v2 工作台状态：
 *  1. 原审计记录、结论、证据一条不删（原审计置顶保留）；
 *  2. 回填 failureMode / 证据 externalReportId / 案例 externalReportIds；
 *  3. 把回填的外部报告号补记到全局入账台账，升级后继续参与幂等计算；
 *  4. 每个案例追加一条“数据升级”审计，记录回填来源；
 *  5. 已有人工结论标记为 active（升级动作本身不使其失效）。
 */
export function migrateV1ToV2(legacySignals: SignalCase[], nowIso: string): WorkbenchStateV2 {
  const signals = structuredClone(legacySignals) as SignalCase[];
  const ledger: WorkbenchStateV2['externalLedger'] = [];

  for (const signal of signals) {
    const mode = signal.failureMode || inferFailureMode(signal);
    signal.failureMode = mode;
    signal.failureModeLabel = signal.failureModeLabel || failureModeLabel(mode);
    signal.externalReportIds ??= [];
    signal.audit ??= [];
    signal.versions ??= [];
    signal.evidence ??= [];
    signal.affectedBatches ??= [signal.batch];
    signal.tasks ??= [];

    const backfilled: string[] = [];
    signal.evidence.forEach((evidence, index) => {
      if (evidence.externalReportId) return;
      const externalId = extractExternalId(evidence, signal.id, index);
      if (!externalId) return;
      evidence.externalReportId = externalId;
      evidence.importBatchId ??= 'LEGACY-V1-MIGRATION';
      backfilled.push(externalId);
      if (!signal.externalReportIds.includes(externalId)) {
        signal.externalReportIds.push(externalId);
      }
      ledger.push({
        externalReportId: externalId,
        caseId: signal.id,
        importBatchId: 'LEGACY-V1-MIGRATION',
        at: nowIso
      });
    });

    // 已有人工结论保持生效（补齐新版本字段）
    for (const version of signal.versions) {
      version.state ??= 'active';
    }

    // 升级审计置顶保留，但绝不覆盖/删除任何历史审计
    signal.audit.unshift({
      id: `AUD-MIG-${signal.id}`,
      actor: '系统',
      action: '数据升级',
      detail:
        `浏览器旧版台账升级为处置链 v2：保留全部历史审计与结论，回填故障模式「${failureModeLabel(mode)}」` +
        (backfilled.length
          ? `，并为 ${backfilled.length} 条外部证据补登报告标识（${backfilled.join('、')}）`
          : '，本案例无需补登外部报告标识') +
        '，补登标识继续参与报告幂等与统计计算。',
      createdAt: nowIso
    });
    signal.updatedAt = nowIso;
  }

  return {
    schemaVersion: 2,
    signals,
    importBatches: [],
    recomputeJobs: [],
    externalLedger: ledger,
    migratedFromV1: true,
    migratedAt: nowIso,
    activeImportId: null
  };
}

export { LEGACY_KEY };

import type { CaseVersion, Disposition, EvidenceItem, RiskLevel, SignalCase } from '$lib/models/signal';
import { failureModeLabel } from '$lib/models/report-package';

export interface RecomputedConclusion {
  riskLevel: RiskLevel;
  disposition: Disposition;
  summary: string;
  rationale: string;
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

/**
 * 基于当前证据矩阵确定性重算核查结论。
 * 同一组证据输入产生同一条结论，便于失败后安全重试。
 */
export function recomputeConclusion(signal: SignalCase): RecomputedConclusion {
  const evidence = signal.evidence;
  const external = evidence.filter(
    (item) => item.type !== 'test' && item.type !== 'literature'
  );
  const strong = evidence.filter((item) => item.strength === 'strong').length;
  const moderate = evidence.filter((item) => item.strength === 'moderate').length;
  const contrary = evidence.filter((item) => item.strength === 'contrary').length;

  let riskLevel = maxRisk(riskFromSeverity(signal.severity), signal.reportCount >= 10 ? 'high' : 'low');
  if (signal.exposedUnits > 0 && signal.occurrenceRate >= 2) riskLevel = maxRisk(riskLevel, 'critical');
  else if (signal.exposedUnits > 0 && signal.occurrenceRate >= 0.75) riskLevel = maxRisk(riskLevel, 'high');

  let disposition: Disposition = 'continue_observation';
  if (riskLevel === 'critical' || (strong >= 2 && contrary === 0)) {
    disposition = 'corrective_action';
  } else if (riskLevel === 'high' || strong >= 1 || moderate >= 2) {
    disposition = 'risk_communication';
  }

  const mode = failureModeLabel(signal.failureMode);
  const dispositionText: Record<Disposition, string> = {
    continue_observation: '继续观察',
    risk_communication: '启动风险沟通',
    corrective_action: '启动纠正措施'
  };

  const contraryNote =
    contrary > 0 ? `并存 ${contrary} 项相反证据，结论保留替代解释并要求继续核查现场条件；` : '';
  const rateNote =
    signal.exposedUnits > 0
      ? `当前 ${signal.reportCount} 条报告 / ${signal.exposedUnits} 台暴露，核查发生率 ${signal.occurrenceRate.toFixed(2)}%。`
      : `当前累计 ${signal.reportCount} 条报告，暴露台数待核。`;

  return {
    riskLevel,
    disposition,
    summary: `证据重算：${signal.product}「${mode}」现有强支持 ${strong} 项、中等支持 ${moderate} 项、相反 ${contrary} 项，建议${dispositionText[disposition]}。`,
    rationale:
      `${rateNote}${contraryNote}` +
      `本结论由系统在证据变化后对 V${signal.versions[0]?.version ?? 0} 失效结论自动重算，人工可在此基础上形成新版本。`
  };
}

/** 重算结论落库时构造的新版本对象（旧版本不删除，仅互相标记取代关系） */
export function buildRecomputedVersion(
  signal: SignalCase,
  result: RecomputedConclusion,
  author: string,
  nowIso: string,
  makeId: (prefix: string) => string
): CaseVersion {
  const nextVersion = (signal.versions[0]?.version ?? 0) + 1;
  return {
    id: makeId('V'),
    version: nextVersion,
    author,
    summary: result.summary,
    disposition: result.disposition,
    rationale: result.rationale,
    createdAt: nowIso,
    state: 'active'
  };
}

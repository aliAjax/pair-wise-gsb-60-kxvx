import { z } from 'zod';

/** 安全运营组在现场离线整理的外部报告类型 */
export const reportKinds = ['complaint', 'repair', 'field_report', 'adverse_event'] as const;
export type ReportKind = (typeof reportKinds)[number];

/** 故障模式规范编码：产品+批号+故障模式三元组是案例归并键 */
export const failureModes = [
  { code: 'occlusion_alarm', label: '阻塞报警异常' },
  { code: 'battery_capacity', label: '电池续航衰减' },
  { code: 'thermal_overheat', label: '充电温升异常' },
  { code: 'measurement_deviation', label: '测量结果偏差' },
  { code: 'housing_damage', label: '外壳结构破损' },
  { code: 'unknown', label: '待归类故障模式' }
] as const;

export type FailureModeCode = (typeof failureModes)[number]['code'];

export function failureModeLabel(code: string): string {
  return failureModes.find((mode) => mode.code === code)?.label ?? code;
}

/**
 * 离线报告包里的一条外部报告。
 * externalReportId 是外部系统（客服/维修/AE/现场服务）原始报告号，
 * 全局唯一，重复导入只入账一次。
 */
export const externalReportSchema = z.object({
  externalReportId: z.string().trim().min(3, '外部报告号不能为空'),
  kind: z.enum(reportKinds),
  product: z.string().trim().min(2),
  batch: z.string().trim().min(2),
  failureMode: z.string().trim().min(2),
  severity: z.number().int().min(1).max(5),
  occurredAt: z.string().min(1),
  title: z.string().trim().min(4),
  source: z.string().trim().min(2),
  strength: z.enum(['strong', 'moderate', 'weak', 'contrary']),
  note: z.string().trim().min(4),
  /** 该批号暴露台数（用于批次发生率统计，可缺省） */
  exposedUnits: z.number().int().nonnegative().optional()
});

export interface ExternalReport extends z.infer<typeof externalReportSchema> {}

export interface ReportPackage {
  id: string;
  name: string;
  /** 离线采集时间（现场环境） */
  collectedAt: string;
  region: string;
  preparedBy: string;
  reports: ExternalReport[];
}

/** 单条报告在导入批次中的处理状态 */
export const reportItemStates = ['pending', 'ingested', 'duplicate', 'failed'] as const;
export type ReportItemState = (typeof reportItemStates)[number];

export interface ImportItemState {
  externalReportId: string;
  state: ReportItemState;
  /** 归并到的案例号（成功时） */
  caseId?: string;
  /** 新建 / 归并 / — */
  action?: 'created' | 'merged';
  /** 触发失效重算的案例号 */
  recomputeCaseIds?: string[];
  attempts: number;
  error?: string;
  /** 幂等命中时记录此前由哪个导入批次入账 */
  firstIngestedBy?: string;
  updatedAt: string;
}

/** 导入批次整体状态 */
export const importBatchStates = ['in_progress', 'completed', 'failed', 'cancelled'] as const;
export type ImportBatchState = (typeof importBatchStates)[number];

export interface ImportBatch {
  id: string;
  packageId: string;
  packageName: string;
  region: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  state: ImportBatchState;
  /** 逐条报告的处理状态，断点续传时据此定位第一条未完成项 */
  items: ImportItemState[];
  /** 报告内容快照：刷新或离开页面后仍可从未完成处重试，不必重新选择报告包文件 */
  reports: ExternalReport[];
  ingestedCount: number;
  duplicateCount: number;
  failedCount: number;
  /** 最后一次失败信息（用于 UI 提示与“从未完成处重试”） */
  lastError?: string;
}

/** 案例结论重算任务（结论失效 → 重算 → 保存成功才恢复生效） */
export const recomputeStates = ['recomputing', 'done', 'failed'] as const;
export type RecomputeState = (typeof recomputeStates)[number];

export interface RecomputeJob {
  id: string;
  caseId: string;
  /** 触发原因：外部报告导入 / 人工补证 / 批量重算 */
  reason: string;
  triggerImportId?: string;
  state: RecomputeState;
  attempts: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** 成功时产生的新版本号 */
  newVersion?: number;
}

/** 浏览器持久化结构（v2）。v1 仅为 SignalCase[] 数组，启动时迁移 */
export interface WorkbenchStateV2 {
  schemaVersion: 2;
  signals: import('./signal').SignalCase[];
  importBatches: ImportBatch[];
  recomputeJobs: RecomputeJob[];
  /** 全局外部报告入账索引：externalReportId -> { caseId, importBatchId, at } */
  externalLedger: Array<{
    externalReportId: string;
    caseId: string;
    importBatchId: string;
    at: string;
  }>;
  migratedFromV1: boolean;
  migratedAt?: string;
  /** 当前正在执行（含失败待续传）的导入批次，null 表示空闲 */
  activeImportId: string | null;
}

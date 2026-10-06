import { z } from 'zod';

export const reportTypes = ['complaint', 'repair', 'adverse_event', 'field_report'] as const;
export type ReportType = (typeof reportTypes)[number];

/**
 * 离线报告包：安全运营组每月把维修、投诉、现场报告整理成文件，
 * 回到内网后与信号台账合并。
 */
export const externalReportSchema = z.object({
  /** 外部报告号：同一报告号重复导入只入账一次（跨报告包同样生效） */
  externalReportId: z.string().trim().min(3, '外部报告号至少 3 个字符'),
  type: z.enum(reportTypes),
  product: z.string().trim().min(2, '产品名称至少 2 个字符'),
  batch: z.string().trim().min(2, '批号至少 2 个字符'),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请填写发生日期'),
  /** 故障模式原文，例如“阻塞报警提前触发”，服务端归一化后参与归并 */
  failureMode: z.string().trim().min(2, '故障模式至少 2 个字符'),
  /** 暴露台数（可选，用于批次统计重算） */
  exposedUnits: z.coerce.number().int().min(0).optional().default(0),
  title: z.string().trim().min(4, '报告标题至少 4 个字符'),
  source: z.string().trim().min(2, '来源至少 2 个字符'),
  description: z.string().trim().min(4, '经过说明至少 4 个字符'),
  strength: z.enum(['strong', 'moderate', 'weak', 'contrary']).optional().default('moderate')
});

export const reportPackageSchema = z.object({
  packageId: z.string().trim().min(3, '报告包编号至少 3 个字符'),
  exportedAt: z.string().min(1, '请填写导出时间'),
  team: z.string().trim().default('安全运营组'),
  reports: z.array(externalReportSchema).min(1, '报告包至少包含 1 条报告')
});

export type ExternalReportInput = z.infer<typeof externalReportSchema>;
export type ReportPackageInput = z.infer<typeof reportPackageSchema>;

export interface ImportEvent {
  at: string;
  stage: string;
  message: string;
  externalReportId?: string;
  signalId?: string;
}

export type ImportItemOutcome =
  | 'created'
  | 'merged'
  | 'duplicate'
  | 'failed'
  | 'skipped';

export interface ImportItemState {
  externalReportId: string;
  outcome?: ImportItemOutcome;
  signalId?: string;
  /** 当前断点阶段：receive=入账未完成；recompute=已入账失效、重算未保存成功 */
  phase?: 'receive' | 'recompute';
  failureMode?: string;
  error?: string;
  attempts: number;
}

export type ImportRunStatus = 'running' | 'failed' | 'completed' | 'paused';

export interface ImportRun {
  id: string;
  packageId: string;
  exportedAt: string;
  team: string;
  /** 原始报告负载（持久化，保证刷新后仍可从断点续作） */
  reports: ExternalReportInput[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: ImportRunStatus;
  /** 断点续传游标：下一条待处理报告下标 */
  cursor: number;
  items: ImportItemState[];
  events: ImportEvent[];
  /** 模拟接收失败的演示设置：在下一条待处理报告处失败一次 */
  failOnceStage?: 'receive' | 'recompute' | 'persist';
  /** 失败信息（status=failed 时存在） */
  error?: string;
  affectedSignalIds: string[];
}

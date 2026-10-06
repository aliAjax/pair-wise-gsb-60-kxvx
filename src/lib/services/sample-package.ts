import type { ReportPackageInput } from '$lib/models/report-package';

/**
 * 示例离线报告包：模拟安全运营组在外网整理、回内网后导入的月度包。
 * 故意覆盖以下链路场景：
 *  - 新产品/新批号/新故障模式 → 建立案例
 *  - 同产品批号同故障模式的多条报告 → 归并到同一案例
 *  - 包内重复报告号 → 只入账一次
 *  - 与种子台账相同产品批号故障模式（IP-800 / IP8-260401 / 阻塞报警）→ 归并并触发结论失效重算
 */
export const sampleReportPackage: ReportPackageInput = {
  packageId: 'OPS-RP-202610-01',
  exportedAt: '2026-10-05T18:00:00.000Z',
  team: '安全运营组',
  reports: [
    {
      externalReportId: 'EXT-261001-C031',
      type: 'complaint',
      product: '注射泵 SP-200',
      batch: 'SP2-260815',
      severity: 3,
      occurredAt: '2026-09-30',
      failureMode: '输注剂量偏差',
      exposedUnits: 420,
      title: '注射泵给药流速偶发偏高投诉',
      source: '客服工单系统',
      description: '护士反馈设定 5 ml/h 实际流速短时偏高，重启后恢复，涉及两台设备。',
      strength: 'moderate'
    },
    {
      externalReportId: 'EXT-261002-R118',
      type: 'repair',
      product: '注射泵 SP-200',
      batch: 'SP2-260815',
      severity: 4,
      occurredAt: '2026-10-01',
      failureMode: '剂量偏差超差',
      exposedUnits: 0,
      title: '注射泵推注机构维修记录',
      source: '区域维修中心',
      description: '拆机发现推注滑块润滑不足，流速校准点漂移，与投诉描述一致。',
      strength: 'strong'
    },
    {
      externalReportId: 'EXT-261003-F044',
      type: 'field_report',
      product: '智能输液泵 IP-800',
      batch: 'IP8-260401',
      severity: 4,
      occurredAt: '2026-10-02',
      failureMode: '阻塞报警提前触发',
      exposedUnits: 0,
      title: 'ICU 现场阻塞报警核查报告',
      source: '现场服务报告 F-802',
      description: '同批管路在第 9 天集中出现阻塞压力提前触发，现场更换管路后恢复。',
      strength: 'strong'
    },
    {
      externalReportId: 'EXT-261004-AE07',
      type: 'adverse_event',
      product: '双相波除颤器 D9',
      batch: 'D9-260722',
      severity: 5,
      occurredAt: '2026-10-03',
      failureMode: '充电模组过温',
      exposedUnits: 0,
      title: '除颤器充电过温不良事件续报',
      source: '不良事件报告 AE-261003',
      description: '另一台同批设备充电时外壳轻微变形并触发过温保护，无人员伤害。',
      strength: 'strong'
    },
    {
      externalReportId: 'EXT-261005-C052',
      type: 'complaint',
      product: '多参数监护仪 M12',
      batch: 'M12-251118',
      severity: 3,
      occurredAt: '2026-10-03',
      failureMode: '电池续航不足',
      exposedUnits: 0,
      title: '监护仪电池续航新增投诉',
      source: '客服工单系统',
      description: '三家医院反馈满电使用时长继续下降，平均较标称低 27%。',
      strength: 'moderate'
    },
    {
      externalReportId: 'EXT-261006-R121',
      type: 'repair',
      product: '注射泵 SP-200',
      batch: 'SP2-260815',
      severity: 3,
      occurredAt: '2026-10-04',
      failureMode: '流速偏差',
      exposedUnits: 0,
      title: '注射泵流速复测维修单',
      source: '区域维修中心',
      description: '复测 4 台设备流速偏差在允许范围内，需结合使用耗材进一步分层。',
      strength: 'contrary'
    },
    {
      externalReportId: 'EXT-261003-F044',
      type: 'field_report',
      product: '智能输液泵 IP-800',
      batch: 'IP8-260401',
      severity: 4,
      occurredAt: '2026-10-02',
      failureMode: '阻塞报警',
      exposedUnits: 0,
      title: '重复报告（应被幂等跳过）',
      source: '现场服务报告 F-802',
      description: '同一外部报告号在包内重复出现，系统只允许入账一次。',
      strength: 'strong'
    },
    {
      externalReportId: 'EXT-261007-F045',
      type: 'field_report',
      product: '智能输液泵 IP-800',
      batch: 'IP8-260403',
      severity: 4,
      occurredAt: '2026-10-04',
      failureMode: '阻塞报警',
      exposedUnits: 640,
      title: '相邻批号阻塞报警现场报告',
      source: '现场服务报告 F-809',
      description: '相邻批号也出现两起提前报警，需判断是否为同一装配根因。',
      strength: 'moderate'
    }
  ]
};

/** 供“下载示例报告包”按钮使用 */
export function downloadSamplePackage(): void {
  const blob = new Blob([JSON.stringify(sampleReportPackage, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${sampleReportPackage.packageId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

import type { ReportPackage } from '$lib/models/report-package';

/**
 * 安全运营组每月在现场离线整理的报告包。
 * 回到内网后通过 /imports 选择包并与信号台账合并。
 *
 * 场景设计：
 *  - 包 A：既有产品的新报告（归并、失效旧结论重算）+ 新产品/新批号（建立案例）+ 包内重复号
 *  - 包 B：跨包重复号（验证“同一外部报告号重复导入只入账一次”）+ 关闭案例收到新证据重开
 */
export const sampleReportPackages: ReportPackage[] = [
  {
    id: 'PKG-2026-10-EAST',
    name: '2026-10 华东片区离线报告包',
    collectedAt: '2026-10-04T18:20:00.000Z',
    region: '华东片区',
    preparedBy: '现场安全运营组 / 赵珂',
    reports: [
      {
        externalReportId: 'CMP-2610-0088',
        kind: 'complaint',
        product: '智能输液泵 IP-800',
        batch: 'IP8-260401',
        failureMode: 'occlusion_alarm',
        severity: 4,
        occurredAt: '2026-10-01',
        title: '夜间治疗再次集中触发阻塞报警',
        source: '客服工单系统',
        strength: 'strong',
        note: '宁波某三甲医院 6 台同批设备一周内 9 次提前报警，均发生在低流速夜间时段。',
        exposedUnits: 2048
      },
      {
        externalReportId: 'F-902',
        kind: 'field_report',
        product: '智能输液泵 IP-800',
        batch: 'IP8-260401',
        failureMode: 'occlusion_alarm',
        severity: 3,
        occurredAt: '2026-10-02',
        title: '现场核查：管路夹持扭矩超控制上限',
        source: '现场服务报告 F-902',
        strength: 'moderate',
        note: '抽检 12 台，8 台夹持扭矩偏高，与报警提前触发时间相关，指向装配一致性问题。'
      },
      {
        externalReportId: 'RPR-9310',
        kind: 'repair',
        product: '智能输液泵 IP-800',
        batch: 'IP8-260403',
        failureMode: 'occlusion_alarm',
        severity: 3,
        occurredAt: '2026-10-03',
        title: '相邻批号设备出现同类零点漂移',
        source: '维修记录 RPR-9310',
        strength: 'moderate',
        note: '260403 批号 2 台设备更换传感器后恢复，故障模式与 260401 一致。'
      },
      {
        externalReportId: 'AE-2610-0007',
        kind: 'adverse_event',
        product: '注射泵 SP-30',
        batch: 'SP30-260915',
        failureMode: 'housing_damage',
        severity: 4,
        occurredAt: '2026-10-02',
        title: '便携注射泵电池仓锁扣断裂',
        source: '不良事件上报系统',
        strength: 'strong',
        note: '转运途中锁扣断裂导致电池松脱、输注中断 2 分钟，未造成患者伤害，为全新产品批号。',
        exposedUnits: 360
      },
      // 包内重复：与上面 CMP-2610-0088 是同一张外部工单的二次导出，必须只入账一次
      {
        externalReportId: 'CMP-2610-0088',
        kind: 'complaint',
        product: '智能输液泵 IP-800',
        batch: 'IP8-260401',
        failureMode: 'occlusion_alarm',
        severity: 4,
        occurredAt: '2026-10-01',
        title: '夜间治疗再次集中触发阻塞报警（重复导出）',
        source: '客服工单系统（离线包二次导出）',
        strength: 'strong',
        note: '同一张工单的重复导出件，用于验证外部报告号幂等。',
        exposedUnits: 2048
      }
    ]
  },
  {
    id: 'PKG-2026-10-NORTH',
    name: '2026-10 华北片区离线报告包',
    collectedAt: '2026-10-05T09:10:00.000Z',
    region: '华北片区',
    preparedBy: '现场安全运营组 / 沈瑜',
    reports: [
      // 跨包重复：华东包已入账，此条导入必须识别为 duplicate
      {
        externalReportId: 'F-902',
        kind: 'field_report',
        product: '智能输液泵 IP-800',
        batch: 'IP8-260401',
        failureMode: 'occlusion_alarm',
        severity: 3,
        occurredAt: '2026-10-02',
        title: '现场核查：管路夹持扭矩超控制上限（跨包重复）',
        source: '现场服务报告 F-902（华北汇总件）',
        strength: 'moderate',
        note: '同一份现场报告被两个片区包引用，验证跨批次全局幂等。'
      },
      {
        externalReportId: 'CMP-2610-0131',
        kind: 'complaint',
        product: '影像工作站 WS-5',
        batch: 'SW-5.3.1',
        failureMode: 'measurement_deviation',
        severity: 3,
        occurredAt: '2026-10-04',
        title: '已关闭版本再次出现缩放后测量偏差',
        source: '客服工单系统',
        strength: 'moderate',
        note: '北京一家医院在 5.3.1 残留终端上复现测量偏差，原修复结论需要重新评估并自动重开案例。',
        exposedUnits: 310
      },
      {
        externalReportId: 'RPR-9355',
        kind: 'repair',
        product: '多参数监护仪 M12',
        batch: 'M12-251118',
        failureMode: 'battery_capacity',
        severity: 4,
        occurredAt: '2026-10-03',
        title: '电池续航衰减比例扩大至 38%',
        source: '维修记录 RPR-9355',
        strength: 'strong',
        note: '天津一家医院 9 台设备复测，容量衰减中位数 38%，较此前 23% 明显扩大。',
        exposedUnits: 876
      }
    ]
  }
];

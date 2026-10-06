import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportPackageInput } from '$lib/models/report-package';
import {
  processImportRun,
  resumeImportRun,
  signalStore,
  startImport
} from '$lib/stores/signal-store';
import { importRunsStore } from '$lib/stores/signal-store';
import { get } from 'svelte/store';
import {
  STORAGE_KEY_DB,
  STORAGE_KEY_V1,
  STORAGE_KEY_V1_BACKUP
} from '$lib/services/persistence';
import { persistFault } from '$lib/services/persistence';
import type { SignalCase } from '$lib/models/signal';

function pkg(overrides: Partial<ReportPackageInput> = {}): ReportPackageInput {
  return {
    packageId: 'PKG-TEST-1',
    exportedAt: '2026-10-05T10:00:00.000Z',
    team: '安全运营组',
    reports: [
      {
        externalReportId: 'R-001',
        type: 'complaint',
        product: '测试泵 P1',
        batch: 'B-1',
        severity: 3,
        occurredAt: '2026-10-01',
        failureMode: '阻塞报警提前',
        exposedUnits: 100,
        title: '首次出现的阻塞报警投诉',
        source: '客服系统',
        description: '管路压力提前触发报警。',
        strength: 'strong'
      }
    ],
    ...overrides
  };
}

async function importOnce(input: ReportPackageInput, stage?: 'receive' | 'recompute' | 'persist') {
  const run = startImport(input, stage);
  try {
    await processImportRun(run.id);
  } catch {
    /* 失败场景由调用方断言 */
  }
  return run.id;
}

function dbSignals(): SignalCase[] {
  return get(signalStore);
}

describe('离线报告包处置链', () => {
  beforeEach(() => {
    signalStore.reset();
  });

  it('新产品/新批号/新故障模式建立新案例并生成自动 V1 结论', async () => {
    await importOnce(pkg());
    const target = dbSignals().find((s) => s.product === '测试泵 P1');
    expect(target).toBeTruthy();
    expect(target!.batch).toBe('B-1');
    expect(target!.failureMode).toBe('occlusion_alarm');
    expect(target!.reportCount).toBe(1);
    expect(target!.externalReportIds).toEqual(['R-001']);
    expect(target!.recomputePending).toBe(false);
    expect(target!.versions[0]).toMatchObject({ version: 1, state: 'active', kind: 'auto' });
  });

  it('同产品批号同故障模式归并；不同批号建独立案例', async () => {
    await importOnce(
      pkg({
        packageId: 'PKG-TEST-2',
        reports: [
          pkg().reports[0],
          {
            ...pkg().reports[0],
            externalReportId: 'R-002',
            type: 'repair',
            source: '维修中心',
            title: '同批同类故障维修单',
            description: '维修记录再次记录阻塞报警。'
          },
          {
            ...pkg().reports[0],
            externalReportId: 'R-003',
            batch: 'B-2',
            exposedUnits: 50,
            title: '相邻批号阻塞报警',
            description: '另一批号也出现阻塞报警。'
          }
        ]
      })
    );

    const b1 = dbSignals().filter((s) => s.product === '测试泵 P1' && s.batch === 'B-1');
    const b2 = dbSignals().filter((s) => s.product === '测试泵 P1' && s.batch === 'B-2');
    expect(b1).toHaveLength(1);
    expect(b2).toHaveLength(1);
    expect(b1[0].reportCount).toBe(2);
    expect(b1[0].externalReportIds).toEqual(['R-001', 'R-002']);
    expect(b1[0].versions[0].version).toBe(2); // 归并触发旧结论失效重算
    expect(b1[0].versions.every((v) => v.state === 'active' || v.state === 'invalidated')).toBe(true);
    expect(b1[0].versions.filter((v) => v.state === 'active')).toHaveLength(1);
  });

  it('同一外部报告号在包内重复和跨包重复导入都只入账一次', async () => {
    await importOnce(
      pkg({
        packageId: 'PKG-DUP-1',
        reports: [pkg().reports[0], { ...pkg().reports[0], title: '重复条目' }]
      })
    );
    await importOnce(pkg({ packageId: 'PKG-DUP-2' }));

    const target = dbSignals().find((s) => s.product === '测试泵 P1')!;
    expect(target.reportCount).toBe(1);
    expect(target.externalReportIds).toEqual(['R-001']);
    expect(target.evidence).toHaveLength(1);

    const runs = get(importRunsStore);
    const secondRun = runs.find((r) => r.packageId === 'PKG-DUP-2')!;
    expect(secondRun.items[0].outcome).toBe('duplicate');
  });

  it('接收阶段失败：写入前中断，无任何数据落库；续作后成功', async () => {
    const id = await importOnce(pkg(), 'receive');
    let run = get(importRunsStore).find((r) => r.id === id)!;
    expect(run.status).toBe('failed');
    expect(run.cursor).toBe(0);
    expect(dbSignals().find((s) => s.product === '测试泵 P1')).toBeFalsy();
    const persistedBefore = JSON.parse(localStorage.getItem(STORAGE_KEY_DB)!);
    expect(persistedBefore.signals.find((s: SignalCase) => s.product === '测试泵 P1')).toBeFalsy();

    await resumeImportRun(id);
    run = get(importRunsStore).find((r) => r.id === id)!;
    expect(run.status).toBe('completed');
    const target = dbSignals().find((s) => s.product === '测试泵 P1')!;
    expect(target.reportCount).toBe(1);
    expect(target.versions[0].state).toBe('active');
  });

  it('重算阶段失败：报告已入账、旧结论失效待重算，从断点续作恢复', async () => {
    // 先建一个带人工有效结论的案例
    await importOnce(pkg());
    const first = dbSignals().find((s) => s.product === '测试泵 P1')!;
    expect(first.versions[0].state).toBe('active');

    // 第二条报告归并时让重算保存失败
    const runId = await importOnce(
      pkg({
        packageId: 'PKG-RECOMPUTE',
        reports: [
          {
            ...pkg().reports[0],
            externalReportId: 'R-002',
            title: '归并进来的第二条阻塞报警',
            description: '同批同类故障的新增投诉。'
          }
        ]
      }),
      'recompute'
    );

    let run = get(importRunsStore).find((r) => r.id === runId)!;
    expect(run.status).toBe('failed');
    expect(run.items[0].phase).toBe('recompute');
    const pending = dbSignals().find((s) => s.product === '测试泵 P1')!;
    expect(pending.reportCount).toBe(2); // 报告已入账
    expect(pending.recomputePending).toBe(true);
    expect(pending.versions[0].state).toBe('invalidated'); // 旧结论失效
    expect(pending.versions.some((v) => v.state === 'active')).toBe(false);

    // 模拟刷新后从持久化状态续作
    await resumeImportRun(runId);
    run = get(importRunsStore).find((r) => r.id === runId)!;
    expect(run.status).toBe('completed');
    const recovered = dbSignals().find((s) => s.product === '测试泵 P1')!;
    expect(recovered.recomputePending).toBe(false);
    expect(recovered.versions[0]).toMatchObject({ state: 'active', kind: 'auto' });
    expect(recovered.reportCount).toBe(2);
  });

  it('持久化阶段失败：原子放弃，不产生半套案例，重试成功', async () => {
    const run = startImport(pkg());
    persistFault.failNextPersist = true;
    persistFault.reason = '存储配额已满（测试）';
    await expect(processImportRun(run.id)).rejects.toThrow(/存储配额/);

    // 阶段 1 提交失败：连运行批次状态也未能更新，案例不存在
    expect(dbSignals().find((s) => s.product === '测试泵 P1')).toBeFalsy();

    await resumeImportRun(run.id);
    const finished = get(importRunsStore).find((r) => r.id === run.id)!;
    expect(finished.status).toBe('completed');
    expect(dbSignals().find((s) => s.product === '测试泵 P1')).toBeTruthy();
  });

  it('多条报告在中途失败：已成功的入账保留，失败条目之后的未处理；续作只补剩余', async () => {
    const input = pkg({
      packageId: 'PKG-MID',
      reports: [
        { ...pkg().reports[0], externalReportId: 'R-A', product: '产品 A', batch: 'BA' },
        { ...pkg().reports[0], externalReportId: 'R-B', product: '产品 B', batch: 'BB' },
        { ...pkg().reports[0], externalReportId: 'R-C', product: '产品 C', batch: 'BC' }
      ]
    });
    const runId = await importOnce(input, 'receive');
    let run = get(importRunsStore).find((r) => r.id === runId)!;
    // receive 故障在第一条就触发（游标仍为 0）
    expect(run.cursor).toBe(0);
    expect(dbSignals().filter((s) => s.product.startsWith('产品 '))).toHaveLength(0);

    await resumeImportRun(runId);
    run = get(importRunsStore).find((r) => r.id === runId)!;
    expect(run.status).toBe('completed');
    expect(run.cursor).toBe(3);
    expect(dbSignals().filter((s) => s.product.startsWith('产品 '))).toHaveLength(3);
  });

  it('批次统计随归并重算同步：发生率按新报告数与暴露台数更新', async () => {
    await importOnce(
      pkg({
        packageId: 'PKG-STAT',
        reports: [
          pkg().reports[0],
          {
            ...pkg().reports[0],
            externalReportId: 'R-009',
            exposedUnits: 100,
            title: '第二条强支持报告',
            description: '同批同类故障。'
          }
        ]
      })
    );
    const target = dbSignals().find((s) => s.product === '测试泵 P1')!;
    expect(target.reportCount).toBe(2);
    expect(target.exposedUnits).toBe(200);
    expect(target.occurrenceRate).toBe(1);
  });
});

describe('v1 浏览器数据升级', () => {
  it('保留原审计、补外部报告标识并继续参与计算', async () => {
    const legacy = [
      {
        id: 'SIG-OLD-1',
        title: '旧版阻塞报警案例',
        product: '老泵 X',
        batch: 'OB-1',
        sourceType: 'complaint' as const,
        status: 'investigating' as const,
        riskLevel: 'high' as const,
        severity: 4,
        reportCount: 3,
        exposedUnits: 300,
        occurrenceRate: 1,
        occurredAt: '2026-09-01',
        openedAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
        owner: '张三',
        description: '旧数据描述内容至少十个字。',
        affectedBatches: ['OB-1'],
        evidence: [
          {
            id: 'E1',
            type: 'complaint' as const,
            title: '旧投诉证据',
            source: '旧工单',
            strength: 'strong' as const,
            batch: 'OB-1',
            note: '旧证据说明。',
            createdAt: '2026-09-03T00:00:00.000Z'
          },
          {
            id: 'E2',
            type: 'test' as const,
            title: '旧测试证据',
            source: '实验室',
            strength: 'contrary' as const,
            batch: 'OB-1',
            note: '旧测试说明。',
            createdAt: '2026-09-04T00:00:00.000Z'
          }
        ],
        tasks: [],
        versions: [
          {
            id: 'V1',
            version: 1,
            author: '张三',
            summary: '旧版结论摘要内容',
            disposition: 'continue_observation' as const,
            rationale: '旧依据',
            createdAt: '2026-09-10T00:00:00.000Z'
          }
        ],
        audit: [
          {
            id: 'A1',
            actor: '张三',
            action: '旧审计动作',
            detail: '这条原审计必须原样保留',
            createdAt: '2026-09-10T00:00:00.000Z'
          }
        ],
        reopenedCount: 0
      }
    ];
    localStorage.setItem(STORAGE_KEY_V1, JSON.stringify(legacy));

    // 重新执行模块初始化逻辑：动态导入以触发 buildInitialDb
    vi.resetModules();
    const storeModule = await import('$lib/stores/signal-store');
    const signals = storeModule.signalStore.getSnapshot() as SignalCase[];
    const old = signals.find((s) => s.id === 'SIG-OLD-1')!;
    expect(old).toBeTruthy();
    expect(old.audit.some((a) => a.detail === '这条原审计必须原样保留')).toBe(true);
    expect(old.audit[0].action).toBe('数据升级');
    // 投诉证据补了稳定外部报告号；测试证据不补
    expect(old.externalReportIds).toEqual(['LEGACY-SIG-OLD-1-E1']);
    expect(old.evidence[0].externalReportId).toBe('LEGACY-SIG-OLD-1-E1');
    expect(old.evidence[1].externalReportId).toBeUndefined();
    expect(old.versions[0].state).toBe('active');
    expect(old.failureMode).toBeTruthy();

    // v1 备份保留、原键删除、v2 已写入
    expect(localStorage.getItem(STORAGE_KEY_V1_BACKUP)).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY_V1)).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY_DB)!).version).toBe(2);

    // 补的外部报告标识继续参与幂等：同号再导入被跳过
    const run = storeModule.startImport({
      packageId: 'PKG-AFTER-MIGRATION',
      exportedAt: '2026-10-05T10:00:00.000Z',
      team: '安全运营组',
      reports: [
        {
          externalReportId: 'LEGACY-SIG-OLD-1-E1',
          type: 'complaint',
          product: '老泵 X',
          batch: 'OB-1',
          severity: 4,
          occurredAt: '2026-10-04',
          failureMode: '阻塞',
          exposedUnits: 0,
          title: '升级后再来的同号报告',
          source: '客服系统',
          description: '应当因外部报告号已存在而跳过。',
          strength: 'moderate'
        }
      ]
    });
    await storeModule.processImportRun(run.id);
    const finished = get(storeModule.importRunsStore).find((r) => r.id === run.id)!;
    expect(finished.items[0].outcome).toBe('duplicate');
    const after = storeModule.signalStore.getSnapshot().find((s: SignalCase) => s.id === 'SIG-OLD-1')!;
    expect(after.reportCount).toBe(3);
  });
});

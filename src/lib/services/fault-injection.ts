import { writable } from 'svelte/store';

/**
 * 演示用故障注入（真实内网合并失败通常来自网络抖动 / 写入校验失败）。
 *
 * - failNextIngest：下一条报告入账时强制失败一次，随后自动解除。
 *   已写入部分随事务回滚，导入批次停在该条，可“从未完成处重试”。
 * - failNextRecompute：下一次结论重算“保存”时强制失败一次，
 *   旧结论保持 invalidated / recomputing 回退，不产生半套结论。
 */
export const faultInjection = writable({
  failNextIngest: false,
  failNextRecompute: false,
  /** 最近一次注入事件日志，便于在界面上说明发生了什么 */
  lastEvent: ''
});

export function armIngestFailure() {
  faultInjection.update((state) => ({ ...state, failNextIngest: true, lastEvent: '' }));
}

export function armRecomputeFailure() {
  faultInjection.update((state) => ({ ...state, failNextRecompute: true, lastEvent: '' }));
}

/** 返回 true 表示本次应失败，并自动解除武装（只失败一次） */
export function consumeIngestFailure(reportId: string): boolean {
  let failed = false;
  faultInjection.update((state) => {
    failed = state.failNextIngest;
    return failed
      ? {
          failNextIngest: false,
          failNextRecompute: state.failNextRecompute,
          lastEvent: `已模拟报告 ${reportId} 接收失败（事务回滚，等待从未完成处重试）`
        }
      : state;
  });
  return failed;
}

export function consumeRecomputeFailure(caseId: string): boolean {
  let failed = false;
  faultInjection.update((state) => {
    failed = state.failNextRecompute;
    return failed
      ? {
          failNextIngest: state.failNextIngest,
          failNextRecompute: false,
          lastEvent: `已模拟 ${caseId} 重算结论保存失败（旧结论维持失效，等待重试）`
        }
      : state;
  });
  return failed;
}

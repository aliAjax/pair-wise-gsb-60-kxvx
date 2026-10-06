<script lang="ts">
  import type { SignalCase } from '$lib/models/signal';
  import { signalStore } from '$lib/stores/signal-store';
  import { workbench } from '$lib/stores/workbench-store';

  $: signals = $signalStore;
  $: recomputingCaseIds = new Set(
    $workbench.recomputeJobs.filter((job) => job.state !== 'done').map((job) => job.caseId)
  );
  let selectedBatch = 'all';

  interface BatchRollup {
    batch: string;
    cases: SignalCase[];
    totalReports: number;
    totalExposed: number;
    highestRisk: SignalCase['riskLevel'];
    externalReportIds: string[];
    recomputing: number;
  }

  const riskOrder = ['low', 'medium', 'high', 'critical'] as const;

  $: batchRollups = (() => {
    const map = new Map<string, SignalCase[]>();
    for (const signal of signals) {
      for (const batch of signal.affectedBatches) {
        const list = map.get(batch) ?? [];
        list.push(signal);
        map.set(batch, list);
      }
    }
    const rollups: BatchRollup[] = [];
    for (const [batch, cases] of map) {
      const totalReports = cases.reduce((sum, signal) => sum + signal.reportCount, 0);
      const totalExposed = cases.reduce((max, signal) => Math.max(max, signal.exposedUnits), 0);
      const highestRisk = cases.reduce(
        (highest, signal) =>
          riskOrder.indexOf(signal.riskLevel) > riskOrder.indexOf(highest) ? signal.riskLevel : highest,
        'low' as SignalCase['riskLevel']
      );
      const externalReportIds = Array.from(new Set(cases.flatMap((signal) => signal.externalReportIds)));
      rollups.push({
        batch,
        cases,
        totalReports,
        totalExposed,
        highestRisk,
        externalReportIds,
        recomputing: cases.filter((signal) => recomputingCaseIds.has(signal.id)).length
      });
    }
    return rollups.sort((a, b) => a.batch.localeCompare(b.batch));
  })();

  $: batches = batchRollups.map((rollup) => rollup.batch);
  $: visibleRollups = batchRollups.filter(
    (rollup) => selectedBatch === 'all' || rollup.batch === selectedBatch
  );
  $: totalExternalReports = new Set(signals.flatMap((signal) => signal.externalReportIds)).size;
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      按生产批号或软件版本聚合信号覆盖、唯一外部报告号与高风险关联；统计随导入与重算同步更新。
    </p>
  </div>
  <div class="flex items-end gap-3">
    <label class="min-w-[220px]">
      <span class="mb-1 block text-sm font-medium">目标批号</span>
      <select class="select" bind:value={selectedBatch}>
        <option value="all">全部批号</option>
        {#each batches as batch}
          <option value={batch}>{batch}</option>
        {/each}
      </select>
    </label>
    <a class="btn variant-soft-primary" href="/imports">导入报告包</a>
  </div>
</div>

<section class="mb-6 grid gap-3 sm:grid-cols-3">
  <div class="rounded border border-surface-300-700 bg-surface-100-900 p-4 text-center">
    <p class="metric-value text-2xl font-semibold">{batches.length}</p>
    <p class="mt-1 text-xs text-surface-500-400">覆盖批号</p>
  </div>
  <div class="rounded border border-surface-300-700 bg-surface-100-900 p-4 text-center">
    <p class="metric-value text-2xl font-semibold">{totalExternalReports}</p>
    <p class="mt-1 text-xs text-surface-500-400">已入账唯一外部报告号</p>
  </div>
  <div class="rounded border border-surface-300-700 bg-surface-100-900 p-4 text-center">
    <p class="metric-value text-2xl font-semibold">{recomputingCaseIds.size}</p>
    <p class="mt-1 text-xs text-surface-500-400">结论失效/重算中案例</p>
  </div>
</section>

<section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
  {#each visibleRollups as rollup (rollup.batch)}
    <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm text-surface-500-400">{rollup.cases.map((signal) => signal.product).join('、')}</p>
          <h2 class="mt-1 font-semibold">{rollup.batch}</h2>
        </div>
        <span class="badge {rollup.highestRisk === 'critical'
          ? 'bg-red-100 text-red-950'
          : rollup.highestRisk === 'high'
            ? 'bg-orange-100 text-orange-950'
            : rollup.highestRisk === 'medium'
              ? 'bg-amber-100 text-amber-950'
              : 'bg-emerald-100 text-emerald-900'}">
          最高 {rollup.highestRisk === 'critical'
            ? '严重'
            : rollup.highestRisk === 'high'
              ? '高'
              : rollup.highestRisk === 'medium'
                ? '中'
                : '低'}风险
        </span>
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-surface-500-400">关联案例</dt>
          <dd class="metric-value mt-1 font-semibold">{rollup.cases.length} 个</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">报告 / 暴露</dt>
          <dd class="metric-value mt-1 font-semibold">{rollup.totalReports} / {rollup.totalExposed}</dd>
        </div>
      </dl>
      <p class="mt-4 text-sm text-surface-600-300">唯一外部报告号 {rollup.externalReportIds.length} 个</p>
      {#if rollup.recomputing > 0}
        <p class="mt-2 text-xs font-medium text-amber-700">{rollup.recomputing} 个案例结论因新证据失效，正在重算</p>
      {/if}
      <div class="mt-4 flex flex-wrap gap-2">
        {#each rollup.cases as signal}
          <a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>{signal.id}</a>
        {/each}
      </div>
    </article>
  {/each}
</section>

<script lang="ts">
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import { signalStore } from '$lib/stores/signal-store';
  import { computeBatchStats } from '$lib/services/selectors';

  $: signals = $signalStore;
  let selectedBatch = 'all';

  $: batches = computeBatchStats(signals);
  $: visibleBatches =
    selectedBatch === 'all' ? batches : batches.filter((stat) => stat.batch === selectedBatch);

  $: visibleSignals = signals.filter(
    (signal) => selectedBatch === 'all' || signal.affectedBatches.includes(selectedBatch)
  );

  const riskLabels: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '严重'
  };
</script>

<svelte:head><title>批次追踪 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">批次追踪</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      按生产批号或软件版本追踪信号覆盖、报告数量、重算发生率与待重算结论，外部报告入账后实时同步。
    </p>
  </div>
  <label class="min-w-[240px]">
    <span class="mb-1 block text-sm font-medium">目标批号</span>
    <select class="select" bind:value={selectedBatch}>
      <option value="all">全部批号（{batches.length}）</option>
      {#each batches as stat}
        <option value={stat.batch}>{stat.batch}</option>
      {/each}
    </select>
  </label>
</div>

<section class="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
  {#each visibleBatches as stat (stat.batch)}
    <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm text-surface-500-400">{stat.products.join('、')}</p>
          <h2 class="mt-1 font-semibold">{stat.batch}</h2>
        </div>
        <span class="badge px-3 py-1 {stat.topRisk === 'critical'
          ? 'bg-red-100 text-red-950'
          : stat.topRisk === 'high'
            ? 'bg-orange-100 text-orange-950'
            : stat.topRisk === 'medium'
              ? 'bg-amber-100 text-amber-950'
              : 'bg-emerald-100 text-emerald-900'}">
          最高 {riskLabels[stat.topRisk]}风险
        </span>
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-surface-500-400">关联案例</dt>
          <dd class="metric-value mt-1 font-semibold">{stat.signalCount}</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">入账报告</dt>
          <dd class="metric-value mt-1 font-semibold">{stat.reportCount}</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">暴露台数</dt>
          <dd class="metric-value mt-1 font-semibold">{stat.exposedUnits}</dd>
        </div>
        <div>
          <dt class="text-surface-500-400">重算发生率</dt>
          <dd class="metric-value mt-1 font-semibold">{stat.occurrenceRate.toFixed(2)}%</dd>
        </div>
      </dl>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-surface-500-400">证据 {stat.evidenceCount} 项</p>
        {#if stat.pendingRecompute > 0}
          <span class="badge bg-amber-100 text-amber-950">{stat.pendingRecompute} 个案例待重算</span>
        {/if}
      </div>
    </article>
  {/each}
</section>

<section class="rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">批号下的案例</h2>
  </div>
  <div class="divide-y divide-surface-300-700">
    {#each visibleSignals as signal (signal.id)}
      <a class="block px-4 py-4 hover:bg-surface-200-800" href={`/signals/${signal.id}`}>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-xs text-surface-500-400">{signal.id} · {signal.failureModeLabel}</p>
            <h3 class="mt-1 font-medium">{signal.title}</h3>
          </div>
          <RiskBadge risk={signal.riskLevel} status={signal.status} />
        </div>
        <p class="mt-2 text-sm text-surface-600-300">
          {signal.reportCount} 条报告 · 重算发生率 {signal.occurrenceRate.toFixed(2)}%
          · 外部报告号 {signal.externalReportIds.length} 个
          {#if signal.recomputePending}<span class="ml-2 text-amber-700">结论待重算</span>{/if}
        </p>
      </a>
    {/each}
  </div>
</section>

<script lang="ts">
  import RiskBadge from '$lib/components/RiskBadge.svelte';
  import { importRunsStore, signalStore } from '$lib/stores/signal-store';
  import { computeOverview } from '$lib/services/selectors';

  $: signals = $signalStore;
  $: runs = $importRunsStore;
  $: metrics0 = computeOverview(signals, runs);
  $: latestRun = runs[0];

  $: metrics = [
    { label: '开放信号', value: metrics0.openSignals, note: '含调查、观察与处置队列' },
    { label: '高及以上风险', value: metrics0.highRiskSignals, note: '需复核人优先确认' },
    { label: '未关闭任务', value: metrics0.openTasks, note: '跨信号调查任务' },
    { label: '逾期任务', value: metrics0.overdueTasks, note: '按任务截止日计算' },
    { label: '结论待重算', value: metrics0.pendingRecompute, note: '旧结论已失效，重算保存后恢复' },
    { label: '已入账外部报告', value: metrics0.importedReports, note: '同一外部报告号只入账一次' },
    { label: '失败待续作批次', value: metrics0.failedImports, note: '可从断点游标继续接收' }
  ];
</script>

<svelte:head><title>总览 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <p class="text-sm font-medium text-teal-700">上市后安全运营</p>
    <h1 class="mt-1 text-2xl font-semibold tracking-normal">信号核查总览</h1>
    <p class="mt-2 text-sm text-surface-600-300">汇总投诉、维修、不良事件和现场报告，按风险推进核查闭环。</p>
  </div>
  <a class="btn variant-filled-primary" href="/imports">接收离线报告包</a>
</div>

{#if metrics0.pendingRecompute > 0 || metrics0.failedImports > 0}
  <section class="mb-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
    {#if metrics0.failedImports > 0}
      <p>
        有 {metrics0.failedImports} 个报告包接收中断，
        <a class="font-semibold underline" href="/imports">前往从未完成处续作 →</a>
      </p>
    {/if}
    {#if metrics0.pendingRecompute > 0}
      <p class={metrics0.failedImports > 0 ? 'mt-1' : ''}>
        有 {metrics0.pendingRecompute} 个案例旧结论已失效、等待重算保存成功后恢复有效。
      </p>
    {/if}
  </section>
{/if}

<section class="workspace-grid mb-6">
  {#each metrics as metric}
    <article class="col-span-12 rounded border border-surface-300-700 bg-surface-100-900 p-4 sm:col-span-6 lg:col-span-4 xl:col-span-3">
      <p class="text-sm text-surface-500-400">{metric.label}</p>
      <p class="metric-value mt-2 text-3xl font-semibold {metric.value > 0 && (metric.label === '结论待重算' || metric.label === '失败待续作批次') ? 'text-amber-700' : ''}">{metric.value}</p>
      <p class="mt-2 text-xs text-surface-500-400">{metric.note}</p>
    </article>
  {/each}
</section>

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="flex items-center justify-between border-b border-surface-300-700 px-4 py-3">
      <div>
        <h2 class="font-semibold">近期信号</h2>
        <p class="text-xs text-surface-500-400">按最后更新时间排序</p>
      </div>
      <a class="text-sm text-primary-700-300 hover:underline" href="/signals">查看全部</a>
    </div>
    <div class="divide-y divide-surface-300-700">
      {#each signals.slice(0, 5) as signal}
        <a class="block px-4 py-4 hover:bg-surface-200-800" href={`/signals/${signal.id}`}>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-xs text-surface-500-400">{signal.id} · {signal.product} · {signal.failureModeLabel}</p>
              <h3 class="mt-1 font-medium">{signal.title}</h3>
            </div>
            <RiskBadge risk={signal.riskLevel} status={signal.status} />
          </div>
          <p class="mt-2 text-sm text-surface-600-300">
            {signal.reportCount} 条报告 · 发生率 {signal.occurrenceRate.toFixed(2)}% · 负责人 {signal.owner}
            {#if signal.recomputePending}<span class="ml-2 text-amber-700">结论待重算</span>{/if}
          </p>
        </a>
      {/each}
    </div>
  </section>

  <aside class="space-y-6">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <div class="flex items-center justify-between">
        <h2 class="font-semibold">最近报告包</h2>
        <a class="text-sm text-primary-700-300 hover:underline" href="/imports">接收记录</a>
      </div>
      {#if latestRun}
        <div class="mt-3 space-y-2 text-sm">
          <p class="font-medium">{latestRun.packageId}</p>
          <p class="text-xs text-surface-500-400">
            进度 {latestRun.cursor}/{latestRun.reports.length} · 状态
            {latestRun.status === 'completed'
              ? '已完成'
              : latestRun.status === 'failed'
                ? '失败待续作'
                : '接收中'}
          </p>
          {#if latestRun.status === 'failed'}
            <a class="btn btn-sm variant-filled-error mt-2" href="/imports">从未完成处续作</a>
          {/if}
        </div>
      {:else}
        <p class="mt-3 text-sm text-surface-500-400">本月尚未接收离线报告包。</p>
      {/if}
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">任务与复核提醒</h2>
      <div class="mt-3 space-y-4">
        {#each signals.flatMap((signal) => signal.tasks.map((task) => ({ ...task, signalId: signal.id }))).filter((task) => task.status !== 'done').slice(0, 5) as task}
          <div class="border-l-2 border-amber-500 pl-3">
            <p class="text-sm font-medium">{task.title}</p>
            <p class="mt-1 text-xs text-surface-500-400">{task.signalId} · {task.owner} · 截止 {task.dueAt}</p>
          </div>
        {:else}
          <p class="text-sm text-surface-500-400">没有待办任务。</p>
        {/each}
      </div>
    </section>
  </aside>
</div>

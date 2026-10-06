<script lang="ts">
  import { importRunsStore, signalStore } from '$lib/stores/signal-store';
  import { buildAuditTimeline } from '$lib/services/selectors';

  $: signals = $signalStore;
  $: runs = $importRunsStore;
  $: auditEntries = buildAuditTimeline(signals, runs);

  let scopeFilter: 'all' | 'case' | 'import' = 'all';
  $: visibleEntries = auditEntries.filter(
    (entry) => scopeFilter === 'all' || entry.scope === scopeFilter
  );

  function exportAll() {
    const payload = {
      generatedAt: new Date().toISOString(),
      importRuns: runs.map((run) => ({
        id: run.id,
        packageId: run.packageId,
        status: run.status,
        cursor: run.cursor,
        items: run.items,
        events: run.events
      })),
      signals: signals.map((signal) => ({
        id: signal.id,
        product: signal.product,
        batch: signal.batch,
        failureMode: signal.failureMode,
        status: signal.status,
        risk: signal.riskLevel,
        recomputePending: signal.recomputePending,
        externalReportIds: signal.externalReportIds,
        conclusion: signal.versions[0] ?? null,
        audit: signal.audit
      }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'medical-device-safety-audit-report.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head><title>审计报告 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">审计与可追溯报告</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      证据并入、结论失效/恢复、状态流转与离线报告包接收事件统一保留操作者、时间和外部报告号。
    </p>
  </div>
  <button class="btn variant-filled-primary" type="button" on:click={exportAll}>导出完整审计包</button>
</div>

<section class="mb-4 flex gap-2">
  <button
    class="btn btn-sm {scopeFilter === 'all' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
    type="button"
    on:click={() => (scopeFilter = 'all')}
  >
    全部（{auditEntries.length}）
  </button>
  <button
    class="btn btn-sm {scopeFilter === 'case' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
    type="button"
    on:click={() => (scopeFilter = 'case')}
  >
    案例审计
  </button>
  <button
    class="btn btn-sm {scopeFilter === 'import' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
    type="button"
    on:click={() => (scopeFilter = 'import')}
  >
    报告包接收事件
  </button>
</section>

<section class="rounded border border-surface-300-700 bg-surface-100-900">
  <div class="border-b border-surface-300-700 px-4 py-3">
    <h2 class="font-semibold">统一审计时间线</h2>
    <p class="mt-1 text-xs text-surface-500-400">共 {visibleEntries.length} 条记录，旧版数据升级时原审计原样保留。</p>
  </div>
  <div class="space-y-5 p-5">
    {#each visibleEntries as entry (entry.id + entry.createdAt)}
      <article class="timeline-item">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-sm font-medium">
            {entry.action} · {entry.actor}
            {#if entry.scope === 'import'}
              <span class="badge ml-1 bg-sky-100 text-sky-950">报告包</span>
            {/if}
          </p>
          <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
        </div>
        <p class="mt-1 text-sm text-surface-600-300">{entry.detail}</p>
        <p class="mt-1 text-xs text-surface-500-400">
          {#if entry.signalId}<a class="hover:underline" href={`/signals/${entry.signalId}`}>{entry.signalId}</a>{/if}
          {#if entry.signalId && entry.product} · {entry.product}{/if}
          {#if entry.externalReportId}<span class="ml-2 font-mono text-teal-700">外部报告：{entry.externalReportId}</span>{/if}
          {#if entry.importBatchId}<span class="ml-2 font-mono">包：{entry.importBatchId}</span>{/if}
        </p>
      </article>
    {:else}
      <p class="py-6 text-center text-sm text-surface-500-400">当前筛选下没有审计记录。</p>
    {/each}
  </div>
</section>

<script lang="ts">
  import { signalStore } from '$lib/stores/signal-store';
  import { workbench } from '$lib/stores/workbench-store';

  $: signals = $signalStore;
  $: auditEntries = signals
    .flatMap((signal) => signal.audit.map((entry) => ({ ...entry, signalId: signal.id, product: signal.product })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  $: ledger = [...$workbench.externalLedger].sort((a, b) => b.at.localeCompare(a.at));
  $: batches = $workbench.importBatches;
  $: jobs = $workbench.recomputeJobs;
  $: migrated = $workbench.migratedFromV1;

  function exportAll() {
    const payload = {
      generatedAt: new Date().toISOString(),
      schemaVersion: 2,
      externalLedger: $workbench.externalLedger,
      importBatches: batches.map((batch) => ({
        id: batch.id,
        packageName: batch.packageName,
        state: batch.state,
        items: batch.items
      })),
      recomputeJobs: jobs,
      signals: signals.map((signal) => ({
        id: signal.id,
        product: signal.product,
        batch: signal.batch,
        failureMode: signal.failureMode,
        externalReportIds: signal.externalReportIds,
        status: signal.status,
        risk: signal.riskLevel,
        activeConclusion: signal.versions.find((version) => version.state === 'active') ?? null,
        versions: signal.versions,
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
      外部报告入账、证据变化、结论失效/重算和状态流转均保留操作者与时间；旧版本与旧审计永不覆盖。
    </p>
  </div>
  <button class="btn variant-filled-primary" type="button" on:click={exportAll}>导出完整审计包</button>
</div>

{#if migrated}
  <section class="mb-6 rounded border border-teal-600/50 bg-teal-50 p-4 text-sm text-teal-900 dark:bg-teal-950/30 dark:text-teal-200">
    本台账由旧版浏览器数据升级而来：升级前的全部审计记录均已原位保留（置顶一条“数据升级”记录），
    回填的外部报告标识已进入入账台账，继续参与后续幂等归并与统计。
  </section>
{/if}

<div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
  <section class="rounded border border-surface-300-700 bg-surface-100-900">
    <div class="border-b border-surface-300-700 px-4 py-3">
      <h2 class="font-semibold">审计时间线</h2>
      <p class="mt-1 text-xs text-surface-500-400">共 {auditEntries.length} 条记录（含导入归并、结论失效与重算、数据升级）</p>
    </div>
    <div class="max-h-[70vh] space-y-5 overflow-y-auto p-5">
      {#each auditEntries as entry (`${entry.signalId}-${entry.id}`)}
        <article class="timeline-item">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm font-medium">{entry.action} · {entry.actor}</p>
            <span class="text-xs text-surface-500-400">{entry.createdAt.slice(0, 16).replace('T', ' ')}</span>
          </div>
          <p class="mt-1 text-sm text-surface-600-300">{entry.detail}</p>
          <p class="mt-1 text-xs text-surface-500-400">{entry.signalId} · {entry.product}</p>
        </article>
      {/each}
    </div>
  </section>

  <aside class="space-y-6">
    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">外部报告入账台账</h2>
      <p class="mt-1 text-xs text-surface-500-400">全局唯一，重复导入在此拦截。共 {ledger.length} 条。</p>
      <div class="mt-3 max-h-64 space-y-2 overflow-y-auto">
        {#each ledger.slice(0, 50) as entry}
          <div class="rounded border border-surface-300-700 p-2 text-xs">
            <p class="font-medium text-teal-700">{entry.externalReportId}</p>
            <p class="mt-1 text-surface-500-400">
              <a class="hover:underline" href={`/signals/${entry.caseId}`}>{entry.caseId}</a>
              · {entry.importBatchId === 'LEGACY-V1-MIGRATION' ? '旧数据回填' : entry.importBatchId}
            </p>
          </div>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">导入批次</h2>
      <div class="mt-3 space-y-2">
        {#each batches as batch}
          <div class="rounded border border-surface-300-700 p-2 text-xs">
            <p class="font-medium">{batch.packageName}</p>
            <p class="mt-1 text-surface-500-400">
              {batch.state} · 入账 {batch.ingestedCount} · 重复 {batch.duplicateCount} · 失败 {batch.failedCount}
            </p>
          </div>
        {:else}
          <p class="text-xs text-surface-500-400">尚无报告包导入记录。</p>
        {/each}
      </div>
    </section>

    <section class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <h2 class="font-semibold">结论重算记录</h2>
      <div class="mt-3 space-y-2">
        {#each jobs as job}
          <div class="rounded border border-surface-300-700 p-2 text-xs">
            <p class="font-medium">{job.caseId} · {job.state === 'done' ? `V${job.newVersion} 已恢复` : job.state}</p>
            <p class="mt-1 text-surface-500-400">{job.reason} · 尝试 {job.attempts} 次</p>
          </div>
        {:else}
          <p class="text-xs text-surface-500-400">暂无重算任务。</p>
        {/each}
      </div>
    </section>
  </aside>
</div>

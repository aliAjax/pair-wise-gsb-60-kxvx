<script lang="ts">
  import { onMount } from 'svelte';
  import {
    armIngestFailure,
    armRecomputeFailure,
    faultInjection
  } from '$lib/services/fault-injection';
  import type { ImportBatch, ImportItemState } from '$lib/models/report-package';
  import { sampleReportPackages } from '$lib/services/sample-packages';
  import {
    resetWorkbench,
    resumePendingRecomputes,
    resumeUnfinishedImports,
    retryRecompute,
    runImport,
    startImport,
    workbench
  } from '$lib/stores/workbench-store';

  let selectedPackageId = sampleReportPackages[0].id;

  onMount(() => {
    // 回到内网打开工作台：自动从上次未完成处继续，无需重新选择报告包
    void resumeUnfinishedImports();
    resumePendingRecomputes();
  });

  $: batches = $workbench.importBatches;
  $: activeBatch = batches.find((batch) => batch.id === $workbench.activeImportId);
  $: jobs = $workbench.recomputeJobs;

  function beginImport() {
    const pkg = sampleReportPackages.find((item) => item.id === selectedPackageId);
    if (!pkg) return;
    const batch = startImport(pkg);
    void runImport(batch.id, pkg.reports);
  }

  function retryBatch(batch: ImportBatch) {
    void runImport(batch.id, batch.reports);
  }

  const itemStateBadge: Record<ImportItemState['state'], { label: string; cls: string }> = {
    pending: { label: '待入账', cls: 'badge bg-surface-200-800' },
    ingested: { label: '已入账', cls: 'badge bg-emerald-100 text-emerald-900' },
    duplicate: { label: '重复跳过', cls: 'badge bg-amber-100 text-amber-950' },
    failed: { label: '接收失败', cls: 'badge bg-red-100 text-red-950' }
  };

  const batchStateLabel: Record<ImportBatch['state'], string> = {
    in_progress: '导入进行中',
    completed: '已完成',
    failed: '失败 · 可从未完成处重试',
    cancelled: '已取消'
  };

  function caseHref(caseId?: string) {
    return caseId ? `/signals/${caseId}` : undefined;
  }
</script>

<svelte:head><title>离线报告包导入 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold">离线报告包导入与续作</h1>
    <p class="mt-1 text-sm text-surface-600-300">
      现场整理的维修、投诉与现场报告包回内网后在此合并：外部报告号只入账一次，新产品/新批号建立案例，已有产品批号按故障模式归并。
    </p>
  </div>
  <button
    class="btn variant-ghost-surface"
    type="button"
    on:click={() => {
      if (confirm('恢复为内置演示台账？将清除当前浏览器中的 v2 处置链数据。')) resetWorkbench();
    }}>恢复演示数据</button
  >
</div>

{#if $workbench.migratedFromV1}
  <section class="mb-6 rounded border border-teal-600 bg-teal-50 p-4 text-sm text-teal-900 dark:bg-teal-950/40 dark:text-teal-200">
    <p class="font-semibold">已完成旧版本地数据升级（{new Date($workbench.migratedAt ?? '').toLocaleString()}）</p>
    <p class="mt-1">
      浏览器里保存的旧台账已升级为处置链 v2：原审计与结论完整保留，旧证据已补上外部报告标识并登记入账台账，继续参与幂等归并、批次统计与结论重算。
    </p>
  </section>
{/if}

<section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-5">
  <h2 class="font-semibold">选择本月离线报告包</h2>
  <div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
    <label>
      <span class="mb-1 block text-sm font-medium">报告包</span>
      <select class="select" bind:value={selectedPackageId}>
        {#each sampleReportPackages as pkg}
          <option value={pkg.id}>{pkg.name}（{pkg.reports.length} 条 · {pkg.region}）</option>
        {/each}
      </select>
      {#each sampleReportPackages.filter((pkg) => pkg.id === selectedPackageId) as pkg}
        <p class="mt-2 text-xs text-surface-500-400">
          {pkg.preparedBy} · 离线采集 {pkg.collectedAt.slice(0, 10)}
        </p>
      {/each}
    </label>
    <div class="flex flex-col justify-end gap-2">
      <button class="btn variant-filled-primary" type="button" on:click={beginImport}>
        与信号台账合并
      </button>
    </div>
  </div>

  <div class="mt-5 rounded border border-surface-300-700 p-4">
    <p class="text-sm font-semibold">故障演练（验证断点续传与结论安全）</p>
    <div class="mt-3 flex flex-wrap gap-3">
      <button
        class="btn btn-sm {$faultInjection.failNextIngest ? 'variant-filled-error' : 'variant-soft-error'}"
        type="button"
        on:click={armIngestFailure}>
        {$faultInjection.failNextIngest ? '已布防：下一条报告将接收失败' : '模拟：下一条报告接收失败'}
      </button>
      <button
        class="btn btn-sm {$faultInjection.failNextRecompute ? 'variant-filled-error' : 'variant-soft-error'}"
        type="button"
        on:click={armRecomputeFailure}>
        {$faultInjection.failNextRecompute ? '已布防：下一次重算保存失败' : '模拟：下一次结论重算保存失败'}
      </button>
    </div>
    {#if $faultInjection.lastEvent}
      <p class="mt-3 text-xs text-error-700">{$faultInjection.lastEvent}</p>
    {/if}
    <p class="mt-2 text-xs text-surface-500-400">
      接收失败时已写入部分随事务回滚，批次停在未完成项；重算保存失败时旧结论维持失效，统计仍按新证据更新。
    </p>
  </div>
</section>

{#if activeBatch}
  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="font-semibold">{activeBatch.packageName}</h2>
        <p class="mt-1 text-xs text-surface-500-400">
          批次 {activeBatch.id} · {activeBatch.region} · {batchStateLabel[activeBatch.state]}
        </p>
      </div>
      {#if activeBatch.state === 'failed'}
        <button class="btn variant-filled-primary" type="button" on:click={() => retryBatch(activeBatch)}>
          从未完成处重试
        </button>
      {/if}
    </div>

    {#if activeBatch.lastError}
      <p class="mt-3 rounded border border-error-300 bg-error-50 p-3 text-sm text-error-900">
        {activeBatch.lastError}。此前已成功入账的条目不会重复处理，重试从第一条未完成报告继续。
      </p>
    {/if}

    <div class="mt-4 grid gap-3 md:grid-cols-4">
      <div class="rounded border border-surface-300-700 p-3 text-center">
        <p class="metric-value text-xl font-semibold">{activeBatch.items.length}</p>
        <p class="mt-1 text-xs text-surface-500-400">报告总数</p>
      </div>
      <div class="rounded border border-emerald-600/40 p-3 text-center">
        <p class="metric-value text-xl font-semibold">{activeBatch.ingestedCount}</p>
        <p class="mt-1 text-xs text-surface-500-400">已入账（新建/归并）</p>
      </div>
      <div class="rounded border border-amber-500/40 p-3 text-center">
        <p class="metric-value text-xl font-semibold">{activeBatch.duplicateCount}</p>
        <p class="mt-1 text-xs text-surface-500-400">重复报告跳过</p>
      </div>
      <div class="rounded border border-red-500/40 p-3 text-center">
        <p class="metric-value text-xl font-semibold">{activeBatch.failedCount}</p>
        <p class="mt-1 text-xs text-surface-500-400">失败待重试</p>
      </div>
    </div>

    <ol class="mt-5 space-y-2">
      {#each activeBatch.items as item (item.externalReportId)}
        {@const badge = itemStateBadge[item.state]}
        {@const report = activeBatch.reports.find((entry) => entry.externalReportId === item.externalReportId)}
        <li class="flex flex-wrap items-center justify-between gap-3 rounded border border-surface-300-700 p-3">
          <div class="min-w-0">
            <p class="text-sm font-medium">{item.externalReportId}</p>
            <p class="mt-1 truncate text-xs text-surface-500-400">
              {report?.product} · {report?.batch} · {report?.title}
            </p>
            {#if item.error}
              <p class="mt-1 text-xs text-error-700">{item.error}</p>
            {/if}
            {#if item.state === 'duplicate' && item.firstIngestedBy}
              <p class="mt-1 text-xs text-amber-700">该报告号已于批次 {item.firstIngestedBy} 入账，不重复计入。</p>
            {/if}
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-surface-500-400">尝试 {item.attempts} 次</span>
            {#if item.action === 'created'}
              <span class="badge variant-soft-primary">新建案例</span>
            {:else if item.action === 'merged'}
              <span class="badge variant-soft-secondary">归并案例</span>
            {/if}
            <span class={badge.cls}>{badge.label}</span>
            {#if caseHref(item.caseId)}
              <a class="btn btn-sm variant-ghost-primary" href={caseHref(item.caseId)}>查看案例</a>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>
{/if}

{#if jobs.length > 0}
  <section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <h2 class="font-semibold">结论重算队列</h2>
    <p class="mt-1 text-xs text-surface-500-400">证据变化后旧结论立即失效，重算保存成功才恢复；失败的条目可手动重试。</p>
    <div class="mt-4 space-y-2">
      {#each jobs as job}
        <div class="flex flex-wrap items-center justify-between gap-3 rounded border border-surface-300-700 p-3">
          <div>
            <p class="text-sm font-medium">
              <a class="text-primary-700-300 hover:underline" href={`/signals/${job.caseId}`}>{job.caseId}</a>
              · {job.reason}
            </p>
            {#if job.error}
              <p class="mt-1 text-xs text-error-700">{job.error}</p>
            {/if}
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-surface-500-400">尝试 {job.attempts} 次</span>
            {#if job.state === 'recomputing'}
              <span class="badge variant-soft-primary">重算保存中…</span>
            {:else if job.state === 'failed'}
              <span class="badge bg-red-100 text-red-950">旧结论失效中</span>
              <button class="btn btn-sm variant-filled-primary" type="button" on:click={() => retryRecompute(job.caseId)}>
                重试保存
              </button>
            {:else}
              <span class="badge bg-emerald-100 text-emerald-900">V{job.newVersion} 已恢复生效</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}

{#if batches.length > 1}
  <section class="rounded border border-surface-300-700 bg-surface-100-900 p-5">
    <h2 class="font-semibold">历史导入批次</h2>
    <div class="mt-4 overflow-x-auto">
      <table class="data-table min-w-[720px]">
        <thead>
          <tr>
            <th>报告包 / 批次</th>
            <th>状态</th>
            <th>入账</th>
            <th>重复</th>
            <th>失败</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {#each batches.filter((batch) => batch.id !== activeBatch?.id) as batch}
            <tr>
              <td>
                <p class="font-medium">{batch.packageName}</p>
                <p class="text-xs text-surface-500-400">{batch.id} · {batch.region}</p>
              </td>
              <td>{batchStateLabel[batch.state]}</td>
              <td>{batch.ingestedCount}</td>
              <td>{batch.duplicateCount}</td>
              <td>{batch.failedCount}</td>
              <td>{batch.updatedAt.slice(0, 16).replace('T', ' ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}

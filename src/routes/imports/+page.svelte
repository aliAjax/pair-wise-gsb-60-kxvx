<script lang="ts">
  import {
    importRunsStore,
    processImportRun,
    resumeImportRun,
    startImport
  } from '$lib/stores/signal-store';
  import { reportPackageSchema, type ReportPackageInput } from '$lib/models/report-package';
  import { downloadSamplePackage, sampleReportPackage } from '$lib/services/sample-package';

  let inputMode: 'file' | 'paste' | 'sample' = 'sample';
  let pasteText = '';
  let parsedPackage: ReportPackageInput | null = null;
  let parseError = '';
  let failStage: '' | 'receive' | 'recompute' | 'persist' = '';
  let running = false;
  let actionError = '';

  $: runs = $importRunsStore;

  function loadSample() {
    parsedPackage = sampleReportPackage;
    parseError = '';
    pasteText = JSON.stringify(sampleReportPackage, null, 2);
  }

  loadSample();

  function parsePasted() {
    parseError = '';
    try {
      const json = JSON.parse(pasteText);
      const result = reportPackageSchema.safeParse(json);
      if (!result.success) {
        parsedPackage = null;
        parseError = result.error.issues[0]?.message ?? '报告包结构校验失败';
        return;
      }
      parsedPackage = result.data;
    } catch (error) {
      parsedPackage = null;
      parseError = error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败';
    }
  }

  function onFile(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pasteText = String(reader.result ?? '');
      parsePasted();
    };
    reader.readAsText(file);
  }

  async function beginImport() {
    if (!parsedPackage) return;
    running = true;
    actionError = '';
    try {
      const run = startImport(
        parsedPackage,
        failStage === '' ? undefined : failStage
      );
      await processImportRun(run.id);
    } catch (error) {
      actionError = error instanceof Error ? error.message : '导入失败';
    } finally {
      running = false;
    }
  }

  async function resume(id: string) {
    running = true;
    actionError = '';
    try {
      await resumeImportRun(id);
    } catch (error) {
      actionError = error instanceof Error ? error.message : '续作失败';
    } finally {
      running = false;
    }
  }

  const statusBadge: Record<string, string> = {
    running: 'badge bg-sky-100 text-sky-950',
    failed: 'badge bg-red-100 text-red-950',
    completed: 'badge bg-emerald-100 text-emerald-950',
    paused: 'badge bg-amber-100 text-amber-950'
  };
  const statusLabel: Record<string, string> = {
    running: '接收中',
    failed: '失败待续作',
    completed: '已完成',
    paused: '已暂停'
  };
  const outcomeLabel: Record<string, string> = {
    created: '建案',
    merged: '归并',
    duplicate: '重复跳过',
    failed: '失败',
    skipped: '跳过'
  };
  const phaseLabel: Record<string, string> = {
    receive: '入账阶段中断',
    recompute: '重算阶段中断'
  };
</script>

<svelte:head><title>离线报告包接收 | 医疗器械安全信号核查平台</title></svelte:head>

<div class="mb-6">
  <p class="text-sm font-medium text-teal-700">离线接收链路</p>
  <h1 class="mt-1 text-2xl font-semibold">离线报告包接收</h1>
  <p class="mt-2 max-w-4xl text-sm text-surface-600-300">
    月度维修、投诉与现场报告包在此与信号台账合并：同一外部报告号只入账一次；新产品/新批号建立案例，
    已有产品批号按故障模式归并；接收失败可从未完成处续作，不会产生半套案例；新证据到达后旧结论失效重算，
    重算保存成功才恢复结论有效。
  </p>
</div>

<section class="mb-6 rounded border border-surface-300-700 bg-surface-100-900 p-5">
  <div class="mb-4 flex flex-wrap items-center gap-3">
    <h2 class="font-semibold">选择报告包</h2>
    <div class="flex gap-1">
      <button
        class="btn btn-sm {inputMode === 'sample' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
        type="button"
        on:click={() => (inputMode = 'sample')}
      >
        示例包
      </button>
      <button
        class="btn btn-sm {inputMode === 'file' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
        type="button"
        on:click={() => (inputMode = 'file')}
      >
        上传 JSON
      </button>
      <button
        class="btn btn-sm {inputMode === 'paste' ? 'variant-filled-primary' : 'variant-ghost-surface'}"
        type="button"
        on:click={() => (inputMode = 'paste')}
      >
        粘贴内容
      </button>
    </div>
    <button class="btn btn-sm variant-ghost-surface" type="button" on:click={downloadSamplePackage}>
      下载示例报告包
    </button>
  </div>

  {#if inputMode === 'file'}
    <label class="block">
      <span class="mb-1 block text-sm font-medium">报告包 JSON 文件</span>
      <input class="input" type="file" accept="application/json,.json" on:change={onFile} />
    </label>
  {:else if inputMode === 'paste'}
    <label class="block">
      <span class="mb-1 block text-sm font-medium">报告包 JSON 内容</span>
      <textarea
        class="textarea font-mono text-xs"
        rows="10"
        bind:value={pasteText}
        on:blur={parsePasted}
      ></textarea>
    </label>
    <button class="btn btn-sm mt-2 variant-soft-primary" type="button" on:click={parsePasted}>
      校验报告包
    </button>
  {:else}
    <p class="text-sm text-surface-600-300">
      已载入示例包 <span class="font-medium">{sampleReportPackage.packageId}</span>
      （{sampleReportPackage.reports.length} 条，含 1 条包内重复、多条归并与新批号场景）。
    </p>
  {/if}

  {#if parseError}
    <p class="mt-3 rounded bg-error-100 p-3 text-sm text-error-900">{parseError}</p>
  {/if}

  {#if parsedPackage}
    <div class="section-rule mt-4 pt-4">
      <div class="grid gap-3 text-sm md:grid-cols-4">
        <div>
          <p class="text-xs text-surface-500-400">报告包编号</p>
          <p class="mt-1 font-medium">{parsedPackage.packageId}</p>
        </div>
        <div>
          <p class="text-xs text-surface-500-400">导出时间</p>
          <p class="mt-1 font-medium">{parsedPackage.exportedAt.slice(0, 10)}</p>
        </div>
        <div>
          <p class="text-xs text-surface-500-400">整理团队</p>
          <p class="mt-1 font-medium">{parsedPackage.team}</p>
        </div>
        <div>
          <p class="text-xs text-surface-500-400">报告条数</p>
          <p class="metric-value mt-1 font-medium">{parsedPackage.reports.length}</p>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-end gap-4">
        <label>
          <span class="mb-1 block text-sm font-medium">故障演练（可选）</span>
          <select class="select" bind:value={failStage}>
            <option value="">正常接收</option>
            <option value="receive">在下一条报告接收时失败（写入前）</option>
            <option value="recompute">在结论重算保存时失败（已入账，待重算）</option>
            <option value="persist">在入账持久化时失败（原子放弃，无半套）</option>
          </select>
        </label>
        <button class="btn variant-filled-primary" type="button" disabled={running} on:click={beginImport}>
          {running ? '正在接收…' : '接收入账'}
        </button>
      </div>
      {#if actionError}
        <p class="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {actionError}
        </p>
      {/if}
    </div>
  {/if}
</section>

<section class="space-y-5">
  <h2 class="font-semibold">批次追踪（{runs.length}）</h2>
  {#each runs as run (run.id)}
    <article class="rounded border border-surface-300-700 bg-surface-100-900 p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-semibold">{run.packageId}</h3>
            <span class={statusBadge[run.status]}>{statusLabel[run.status]}</span>
          </div>
          <p class="mt-1 text-xs text-surface-500-400">
            {run.team} · 导出 {run.exportedAt.slice(0, 10)} · 开始 {run.startedAt.slice(0, 16).replace('T', ' ')}
            {#if run.finishedAt}· 完成 {run.finishedAt.slice(0, 16).replace('T', ' ')}{/if}
          </p>
        </div>
        <div class="text-right text-sm">
          <p class="metric-value font-semibold">
            {run.items.filter((item) => item.outcome === 'created' || item.outcome === 'merged' || item.outcome === 'duplicate').length}
            / {run.reports.length}
          </p>
          <p class="text-xs text-surface-500-400">已处理条数</p>
        </div>
      </div>

      <!-- 断点进度条 -->
      <div class="mt-3 h-2 overflow-hidden rounded bg-surface-200-800">
        <div
          class="h-full bg-teal-600 transition-all"
          style="width: {(run.cursor / run.reports.length) * 100}%"
        ></div>
      </div>
      <p class="mt-1 text-xs text-surface-500-400">
        断点游标：第 {run.cursor + (run.status === 'completed' ? 0 : 1)} / {run.reports.length} 条
        · 建案 {run.items.filter((i) => i.outcome === 'created').length}
        · 归并 {run.items.filter((i) => i.outcome === 'merged').length}
        · 重复 {run.items.filter((i) => i.outcome === 'duplicate').length}
      </p>

      {#if run.error}
        <div class="mt-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p class="font-medium">失败原因</p>
          <p class="mt-1">{run.error}</p>
          <button class="btn btn-sm mt-3 variant-filled-error" type="button" disabled={running} on:click={() => resume(run.id)}>
            从未完成处续作
          </button>
        </div>
      {/if}

      <div class="mt-4 grid gap-2">
        {#each run.items as item, index (run.id + item.externalReportId)}
          {@const report = run.reports[index]}
          <div class="flex flex-wrap items-center gap-3 rounded bg-surface-50-950 px-3 py-2 text-sm">
            <span class="metric-value w-6 text-xs text-surface-500-400">{index + 1}</span>
            <span class="font-medium">{item.externalReportId}</span>
            <span class="text-xs text-surface-500-400">{report.product} · {report.batch}</span>
            {#if item.outcome}
              <span class="badge">{outcomeLabel[item.outcome]}</span>
            {/if}
            {#if item.phase && run.status === 'failed'}
              <span class="badge bg-amber-100 text-amber-950">{phaseLabel[item.phase]}</span>
            {/if}
            {#if item.signalId}
              <a class="text-xs text-primary-700-300 hover:underline" href={`/signals/${item.signalId}`}>
                {item.signalId}
              </a>
            {/if}
            {#if item.error}
              <span class="w-full text-xs text-red-700">{item.error}</span>
            {/if}
          </div>
        {/each}
      </div>

      <details class="mt-3">
        <summary class="cursor-pointer text-xs text-surface-500-400">查看接收事件时间线（{run.events.length}）</summary>
        <div class="mt-3 space-y-2">
          {#each run.events as event}
            <div class="timeline-item text-sm">
              <p class="font-medium">{event.stage} · {event.at.slice(11, 16)}</p>
              <p class="text-surface-600-300">{event.message}</p>
            </div>
          {/each}
        </div>
      </details>
    </article>
  {:else}
    <p class="rounded border border-dashed border-surface-300-700 p-6 text-center text-sm text-surface-500-400">
      还没有接收过报告包。选择示例包后点击“接收入账”开始。
    </p>
  {/each}
</section>

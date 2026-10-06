<script lang="ts">
  import type { SignalCase } from '$lib/models/signal';
  import RiskBadge from './RiskBadge.svelte';
  import { workbench } from '$lib/stores/workbench-store';

  export let signals: SignalCase[];

  const sourceLabels: Record<SignalCase['sourceType'], string> = {
    complaint: '投诉',
    repair: '维修',
    adverse_event: '不良事件',
    field_report: '现场报告'
  };

  $: staleCaseIds = new Set(
    $workbench.recomputeJobs.filter((job) => job.state !== 'done').map((job) => job.caseId)
  );
  $: failedCaseIds = new Set(
    $workbench.recomputeJobs.filter((job) => job.state === 'failed').map((job) => job.caseId)
  );
</script>

<div class="overflow-x-auto">
  <table class="data-table min-w-[1020px]">
    <thead>
      <tr>
        <th>信号</th>
        <th>产品 / 批号 / 故障模式</th>
        <th>风险与状态</th>
        <th>结论</th>
        <th>发生率</th>
        <th>负责人</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      {#each signals as signal (signal.id)}
        <tr>
          <td>
            <a class="font-semibold text-primary-700-300 hover:underline" href={`/signals/${signal.id}`}>
              {signal.id}
            </a>
            <p class="mt-1 max-w-[380px] text-sm text-surface-600-300">{signal.title}</p>
            <p class="mt-1 text-xs text-surface-500-400">{sourceLabels[signal.sourceType]}来源</p>
          </td>
          <td>
            <p class="font-medium">{signal.product}</p>
            <p class="text-sm text-surface-500-400">{signal.batch}</p>
            <p class="text-xs text-surface-500-400">{signal.failureModeLabel}</p>
          </td>
          <td><RiskBadge risk={signal.riskLevel} status={signal.status} /></td>
          <td>
            {#if signal.versions.some((version) => version.state === 'active')}
              <span class="badge bg-emerald-100 text-emerald-900">生效中</span>
            {:else if failedCaseIds.has(signal.id)}
              <span class="badge bg-red-100 text-red-950">失效待重试</span>
            {:else if staleCaseIds.has(signal.id)}
              <span class="badge bg-amber-100 text-amber-950">重算中</span>
            {:else}
              <span class="badge bg-surface-200-800">无结论</span>
            {/if}
          </td>
          <td>
            <p class="metric-value font-semibold">{signal.occurrenceRate.toFixed(2)}%</p>
            <p class="text-xs text-surface-500-400">{signal.reportCount} 条 / {signal.externalReportIds.length} 报告号</p>
          </td>
          <td>{signal.owner}</td>
          <td>
            <a class="btn btn-sm variant-soft-primary" href={`/signals/${signal.id}`}>打开核查</a>
          </td>
        </tr>
      {:else}
        <tr>
          <td colspan="7" class="py-12 text-center text-surface-500-400">没有符合当前条件的信号。</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

export interface FailureMode {
  code: string;
  label: string;
}

/**
 * 故障模式归一化：把不同写法的同一类故障归到同一编码。
 * 归并规则：产品 + 批号 + 故障模式编码 三者一致才并入已有案例。
 */
const RULES: Array<{ code: string; label: string; keywords: string[] }> = [
  { code: 'occlusion_alarm', label: '阻塞报警', keywords: ['阻塞', '堵管', '管路压力', '压力提前', 'occlusion'] },
  { code: 'battery_endurance', label: '电池续航', keywords: ['续航', '电池', '电量', '充电', 'battery'] },
  { code: 'thermal_overheat', label: '温升异常', keywords: ['温升', '过热', '过温', '发烫', '外壳变形', 'thermal', 'overheat'] },
  {
    code: 'dosing_deviation',
    label: '剂量流速偏差',
    keywords: ['剂量', '流速', '输注', '推注', '给药', 'dose', 'flow rate']
  },
  { code: 'measurement_deviation', label: '测量偏差', keywords: ['测量', '偏差', '不准', '误差', 'measurement', 'deviation'] },
  { code: 'software_glitch', label: '软件异常', keywords: ['软件', '死机', '重启', '闪退', '界面', 'software', 'crash'] },
  { code: 'leakage', label: '泄漏', keywords: ['泄漏', '漏液', '漏气', '密封', 'leak'] },
  { code: 'alarm_failure', label: '报警失效', keywords: ['报警失效', '未报警', '不报警', '无声', 'alarm fail'] },
  { code: 'electrical_safety', label: '电气安全', keywords: ['漏电', '触电', '短路', '打火', 'electrical'] }
];

export function normalizeFailureMode(raw: string): FailureMode {
  const text = raw.trim().toLowerCase();
  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      return { code: rule.code, label: rule.label };
    }
  }
  // 未知故障模式：以原文生成稳定编码（不同原文各自建案，避免误归并）
  const code =
    'mode_' +
    text
      .replace(/[\s\-_/（）()【】\[\]:：，,。.、]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'mode_unknown';
  return { code, label: raw.trim().slice(0, 20) };
}

/** 匹配键：产品 + 批号 + 故障模式 */
export function caseMatchKey(product: string, batch: string, failureMode: string): string {
  return `${product.trim().toLowerCase()}::${batch.trim().toLowerCase()}::${failureMode}`;
}

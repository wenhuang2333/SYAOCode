/**
 * 渲染层共用的格式化纯函数。
 *
 * 纪律：**不把"未知"显示成 0**。缺失值一律显示 `—`，
 * 与 `27` §6 的"不伪造"原则一致（颜色与数字都不是唯一信息载体）。
 */

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** 千分位数字；`null` / `undefined` / 非有限值显示 `—`。 */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return numberFormat.format(value);
}

/** 紧凑数字（万 / 亿），用于角标。 */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return numberFormat.format(value);
}

/** 美元金额；`null` 显示 `—`。 */
export function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

/** 时长（毫秒 → 人类可读）。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round(ms / 1000) % 60}s`;
}

/** 字节数；`null` 表示"未知大小"，不冒充 0。 */
export function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 本地时间；无效时间戳显示 `—`。 */
export function formatClock(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString();
}

/** 相对时间（粗粒度，用于"最近更新"）。 */
export function formatRelative(timestamp: number | null | undefined, now = Date.now()): string {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—';
  const delta = now - timestamp;
  if (delta < 0) return '刚刚';
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

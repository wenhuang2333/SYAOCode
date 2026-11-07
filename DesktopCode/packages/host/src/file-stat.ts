/**
 * 文件统计与预览（有界读取）。
 *
 * 预算来自 `27` §7.4（沿用 ZCode 在真实故障里打磨出来的数值）：
 *  - 单文件统计上限 **1 MiB**：超过 → `too_large`，**不返回部分计数**；
 *  - 分块读取 **64 KiB**：任意块发现 NUL 字节 → 判为二进制，立即停止；
 *  - 越界判定 = 读满上限 **+ 1 字节**：只判越界，不猜内容。
 *
 * 失败一律回退到"不可统计"（`stat: 'unavailable'`），**不猜、不用 0 冒充**。
 */

import * as fs from 'node:fs/promises';

export const DEFAULT_STAT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CHUNK_BYTES = 64 * 1024;

export type FileStatKind = 'text' | 'binary' | 'too_large' | 'missing' | 'unreadable' | 'not_file';

export interface FileStat {
  readonly kind: FileStatKind;
  /** 文本行数；二进制 / 超限 / 读取失败时为 `null`。 */
  readonly lines: number | null;
  /** 文件字节数；读不出来时为 `null`。 */
  readonly bytes: number | null;
  readonly truncated: boolean;
}

export interface StatOptions {
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
}

/**
 * 统计一个文件的行数。
 *
 * 行数口径：**换行符个数**（末行无换行时也计一行），
 * 与编辑器"行号"观感一致。
 */
export async function statFile(absPath: string, opts: StatOptions = {}): Promise<FileStat> {
  const maxBytes = opts.maxBytes ?? DEFAULT_STAT_MAX_BYTES;
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { kind: code === 'ENOENT' ? 'missing' : 'unreadable', lines: null, bytes: null, truncated: false };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'not_file', lines: null, bytes: null, truncated: false };
    if (stat.size > maxBytes) {
      // 越界：只判越界，不读内容，不返回部分计数。
      return { kind: 'too_large', lines: null, bytes: stat.size, truncated: true };
    }
    const buffer = Buffer.alloc(Math.min(chunkBytes, maxBytes + 1));
    let read = 0;
    let lines = 0;
    let sawByte = false;
    let lastWasNewline = true; // 空文件行数为 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, read);
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > maxBytes) {
        // 读满上限 + 1 字节 → 越界（不返回部分计数）。
        return { kind: 'too_large', lines: null, bytes: stat.size, truncated: true };
      }
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 0) return { kind: 'binary', lines: null, bytes: stat.size, truncated: false };
        if (buffer[i] === 10) {
          lines += 1;
          lastWasNewline = true;
          sawByte = true;
          continue;
        }
        if (buffer[i] !== 13) lastWasNewline = false;
        sawByte = true;
      }
    }
    const total = sawByte && !lastWasNewline ? lines + 1 : lines;
    return { kind: 'text', lines: total, bytes: stat.size, truncated: false };
  } catch {
    return { kind: 'unreadable', lines: null, bytes: null, truncated: false };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * 有界文本预览（供产出预览用）。
 *
 * 与统计分开：预览允许截断，统计不允许给半个数字。
 */
export interface TextPreview {
  readonly text: string;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly bytes: number | null;
}

export async function readTextPreview(absPath: string, maxBytes = 512 * 1024): Promise<TextPreview> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return { text: '', truncated: false, binary: false, bytes: null };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { text: '', truncated: false, binary: false, bytes: null };
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const slice = buffer.subarray(0, bytesRead);
    if (slice.includes(0)) return { text: '', truncated: false, binary: true, bytes: stat.size };
    return { text: slice.toString('utf8'), truncated: stat.size > maxBytes, binary: false, bytes: stat.size };
  } catch {
    return { text: '', truncated: false, binary: false, bytes: null };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

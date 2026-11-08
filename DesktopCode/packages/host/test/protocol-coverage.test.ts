/**
 * DHP 协议面与 Host 实现的**覆盖核对**。
 *
 * 为什么需要它：`packages/dhp` 是协议契约，Host 是实现。两边是**分开演进**的——
 * 在 dhp 里加一个方法而忘了在 host 里 register，编译**不会报错**，
 * 运行时才会以 "method not found" 暴露，而且往往要等到用户点到那个功能才发现。
 *
 * 这个文件把"哪些方法必须有 handler"变成可执行的断言：
 *  1. 每个**请求**方法（Method / WorkbenchMethod / FeatureMethod）都必须有 handler，
 *     或者被明确列入"已知未实现"清单（终端 = N-1），并带上原因；
 *  2. **通知**（Notification / FeatureNotification）是服务端→客户端，
 *     不需要 handler——但不能被误当成请求方法漏实现；
 *  3. 反向：host 里 register 的常量必须在 dhp 里声明过（不能注册不存在的协议方法）。
 *
 * 清单里每一条都写清原因，而不是一句"暂时跳过"——否则清单会烂成垃圾桶。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// 测试在 packages/host/test/ → DesktopCode 根在三级之上。
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string): string => readFileSync(path.join(DESKTOP_ROOT, rel), 'utf8');

/** 从 `export const X = { A: 'wire', ... } as const` 里取出 常量名 → wire 名。 */
function enumMaps(source: string): Record<string, Record<string, string>> {
  const maps: Record<string, Record<string, string>> = {};
  for (const block of source.matchAll(/export const (\w+) = \{([\s\S]*?)\n\} as const;/g)) {
    const name = block[1] ?? '';
    const body = block[2] ?? '';
    const entries: Record<string, string> = {};
    for (const entry of body.matchAll(/^\s+([A-Za-z]+): '([^']+)',/gm)) {
      entries[entry[1] ?? ''] = entry[2] ?? '';
    }
    if (Object.keys(entries).length > 0) maps[name] = entries;
  }
  return maps;
}

/**
 * 协议里已声明、但 Host **尚未发送**的通知。
 *
 * 与"未实现"不同：通知是服务端→客户端，客户端没有分发点意味着收到就丢。
 * 目前 `app/notice` 只声明未发送（更新提示 / 预算告警都还没做），
 * 所以客户端不需要处理——但这条要显式登记，不能靠"恰好没人发"来保持绿色。
 */
const NOT_YET_EMITTED: Readonly<Record<string, string>> = {
  AppNotice: '预留：更新可用 / 预算告警尚未产生，Host 从未 broadcast 过',
};

const REQUEST_ENUMS = new Set(['Method', 'WorkbenchMethod', 'FeatureMethod', 'AgentMethod', 'McpMethod']);
const NOTIFICATION_ENUMS = new Set(['Notification', 'FeatureNotification']);

const dhpSource = [
  read('packages/dhp/src/methods.ts'),
  read('packages/dhp/src/workbench.ts'),
  read('packages/dhp/src/features.ts'),
].join('\n');
const maps = enumMaps(dhpSource);

const hostSource = [
  read('packages/host/src/host.ts'),
  read('packages/host/src/dhp-server.ts'),
].join('\n');

/** host 里实际 register（或特别处理）的协议常量名。 */
const handled = new Set<string>([...hostSource.matchAll(/(?:Method|WorkbenchMethod|FeatureMethod|AgentMethod|McpMethod)\.([A-Za-z]+)/g)].map((m) => m[1] ?? ''));
/** `hello` 不通过 register：`dhp-server.ts` 在处理循环里直接判等并处理。 */
handled.add('Hello');

/**
 * 已知**未实现**的请求方法（有原因，不是笼统跳过）。
 *
 * 新增到此清单必须同时更新 `doc/DesktopDoc/26` 的 N-1——
 * 这个清单是"对外承认的缺口"，不是"暂时懒得写"。
 */
const KNOWN_UNIMPLEMENTED: Readonly<Record<string, string>> = {
  'terminal/create': 'N-1：桌面端不做终端（分屏 + 字节流 + resize 属于内核立项范围）',
  'terminal/input': 'N-1：同上',
  'terminal/resize': 'N-1：同上',
  'terminal/close': 'N-1：同上',
};

describe('每个声明的请求方法都必须有 handler', () => {
  const requestMethods: { wire: string; constant: string; enumName: string }[] = [];
  for (const [enumName, entries] of Object.entries(maps)) {
    if (!REQUEST_ENUMS.has(enumName)) continue;
    for (const [constant, wire] of Object.entries(entries)) {
      requestMethods.push({ wire, constant, enumName });
    }
  }

  it('协议里确实声明了请求方法（防止解析失效导致空断言）', () => {
    expect(requestMethods.length).toBeGreaterThan(60);
  });

  it('除了已知未实现的，其余都有 handler', () => {
    const missing = requestMethods.filter(
      (method) => !handled.has(method.constant) && KNOWN_UNIMPLEMENTED[method.wire] === undefined,
    );
    expect(missing.map((method) => `${method.wire} (${method.enumName}.${method.constant})`)).toEqual([]);
  });

  it('已知未实现清单里的方法确实尚未实现（清单不能养僵尸条目）', () => {
    // 反向检查：如果哪天实现了 terminal/*，这条会失败，提醒把它从清单里删掉。
    const nowImplemented = Object.keys(KNOWN_UNIMPLEMENTED).filter((wire) =>
      requestMethods.some((method) => method.wire === wire && handled.has(method.constant)),
    );
    expect(nowImplemented).toEqual([]);
  });

  it('已知未实现的每条都写了原因', () => {
    for (const [wire, reason] of Object.entries(KNOWN_UNIMPLEMENTED)) {
      // 允许 'N-1：同上' 这类简短但有明确指向的引用，只拒绝空串/占位符。
      expect(reason.trim().length, `${wire} 缺少原因说明`).toBeGreaterThan(3);
    }
  });
});

describe('通知不需要 handler，但不能与请求方法混淆', () => {
  it('通知常量没有被当成请求方法登记', () => {
    for (const enumName of NOTIFICATION_ENUMS) {
      expect(Object.keys(maps[enumName] ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('"已声明未发送"的通知确实还没被发送（清单不能养僵尸条目）', () => {
    // 反向：如果哪天 Host 开始 broadcast，这条会失败，提醒补客户端分发点。
    const hostSources = read('packages/host/src/host.ts') + read('packages/host/src/dhp-server.ts');
    const nowEmitted = Object.keys(NOT_YET_EMITTED).filter((constant) =>
      new RegExp(`Notification\\.${constant}\\b`).test(hostSources),
    );
    expect(nowEmitted).toEqual([]);
  });

  it('每个客户端应处理的通知都有分发点（否则服务端发了、前端收不到）', () => {
    // 客户端用常量判等（`case Notification.SessionEvent:`）而不是字面量，
    // 所以核对常量名，不核对 wire 名。
    const connection = read('packages/client/src/connection.ts');
    const handledNotifications = new Set(
      [...connection.matchAll(/case (?:Notification|FeatureNotification)\.([A-Za-z]+)/g)].map((m) => m[1] ?? ''),
    );
    // `terminal/*` 属于未实现的终端能力（N-1）：客户端不分发是正确的。
    const terminalConstants = new Set(['TerminalData', 'TerminalExit']);
    const declaredUnused = new Set(Object.keys(NOT_YET_EMITTED));
    const expected = Object.entries(maps['Notification'] ?? {})
      .concat(Object.entries(maps['FeatureNotification'] ?? {}))
      .filter(([constant]) => !terminalConstants.has(constant) && !declaredUnused.has(constant))
      .map(([constant]) => constant);
    expect(expected.filter((constant) => !handledNotifications.has(constant))).toEqual([]);
  });
});

describe('反向：host 不能注册协议里不存在的方法', () => {
  it('register 用到的常量都在 dhp 里声明过', () => {
    const declared = new Set<string>();
    for (const entries of Object.values(maps)) for (const constant of Object.keys(entries)) declared.add(constant);
    const registered = [...hostSource.matchAll(/register\((?:Method|WorkbenchMethod|FeatureMethod|AgentMethod|McpMethod)\.([A-Za-z]+)/g)]
      .map((m) => m[1] ?? '');
    expect(registered.filter((name) => !declared.has(name))).toEqual([]);
  });
});

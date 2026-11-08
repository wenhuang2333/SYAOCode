# STEER-CHANNEL · 内核运行期 steer 通道

> 面向内核使用者（embedder / CLI / 桌面 Host）的工程说明。行为契约的**权威版本**是本地设计文档集里的《28-多轮steer行为契约》；本文只讲内核 API 怎么用、边界在哪、以及哪些事内核**不做**。

## 1. 用途

一次执行（run）**还在运行**时，用户可以再提交一段补充指令（steer）。它不打断当前模型流、不取消正在执行的工具、不绕过审批，而是在下一个安全边界作为一条普通 user 消息进入模型历史。

桌面端的场景是"运行中补充说明"。内核只提供**通道**，不负责界面。

## 2. API

```ts
import { createSteerQueue, STEER_DEFAULT_MAX_ITEMS, STEER_MAX_TEXT_LENGTH } from '@liwencode/core';

const steer = createSteerQueue();          // 每个执行一个队列
await agent.run(input, { steer });         // RunOptions.steer
```

| 导出 | 说明 |
| --- | --- |
| `createSteerQueue(opts?)` | 建一个执行期队列。`opts.maxItems` 默认 32，`opts.maxTextLength` 默认 10 000 |
| `SteerQueueHandle.push({ id, text })` | 提交一条 steer。**fail-closed**：不抛异常，返回 `{ accepted, … }` 或 `{ accepted: false, reason }` |
| `SteerQueueHandle.drain()` | 取走全部待处理（FIFO）。队列继续接受新提交 |
| `SteerQueueHandle.close()` | 关闭并返回**未被消费**的全部（内核在 run 结束时调用） |
| `STEER_MAX_TEXT_LENGTH` / `STEER_DEFAULT_MAX_ITEMS` | 两个常量，Host 用它们做参数校验 |

**拒绝原因**：`empty` / `too_long` / `queue_full` / `closed` / `duplicate`。
判定优先级固定为 `closed → empty → too_long → duplicate → queue_full`（先到先判）。

**不传 `steer` = 没有 steer 能力**：运行循环走原有路径，行为不变。

## 3. 消费边界

唯一的注入点在 **`turn.start` 之后、构造请求之前**：

| steer 到达时机 | 行为 |
| --- | --- |
| 模型正在流式输出 | 只排队；当前 provider 请求不被改写 |
| 工具批次正在执行 | 等本批次全部结束再注入；每个 `tool_use` 仍恰好一个 `tool_result` |
| 等待权限审批 | 可以排队；审批仍按原流程结算（steer 不构成批准或提权） |
| assistant 没有工具调用、原本要结束 | 先结束本轮，再续一轮把 steer 消费掉——**不会提前结束** |
| 多个 steer 排队 | FIFO，不覆盖、不乱序、不合并 |
| stop / abort / 致命错误 | 未消费项以 `steer.not_consumed` 上报并关闭队列，**不会在以后的重跑里自动重放** |
| 达到 maxTurns / 预算 / 时间上限 | 不因为还有 steer 就绕过上限 |

注入的消息是**普通 user 消息**，带 `meta.steerId` 标记来源：

```ts
{ id, role: 'user', content: [{ type: 'text', text }], meta: { createdAt, steerId } }
```

它会被写入会话历史（`session.append`），因此恢复 / fork 后不会重复出现。

## 4. 事件

内核新增两类事件（事件契约 v2 的 `AgentEventBody`）：

| 事件 | 何时发出 |
| --- | --- |
| `steer.consumed` | 该条 steer 已在安全边界注入（带 `turn`） |
| `steer.not_consumed` | 该条 steer 到运行结束仍未注入（带 `reason`） |

未消费原因：`aborted` / `max_turns` / `budget_exhausted` / `timeout` / `fatal_error` / `repeated_failure` / `closed`。

> **排队事件不在内核**：内核只在"被接受"时才知道一条 steer 存在，但"排队"是**产品状态**（谁在等、显示成什么），由 Host 发出（桌面端是 `steer.queued`）。内核不关心 UI。

## 5. 内核**不做**的事

- **不做权限操作**：steer 不切模型、不切权限模式、不加工具白名单。
- **不做自动重放**：未消费的 steer 只上报一次；是否重发由上层决定（桌面端的选择是"可见地标为未注入 + 用户手动重发"）。
- **不做崩溃恢复**：进程崩溃后队列内容随进程消失。是否持久化排队记录由 Host 决定（桌面端选择持久化，但**不自动重放**，只补一条"未注入"）。
- **不做容量治理**：上限是"每执行 32 条"，跨执行的全局上限不在内核。

## 6. 测试

`packages/core/test/steer.test.ts`（17 例）覆盖：队列语义（FIFO / 去重 / 容量 / 长度）、13 个消费边界场景（流式中、工具批次中、审批中、末轮输出中、停止、四类上限）、历史只写一次与恢复/fork、以及"没有 steer 时行为不变"。

完整回归：`cd code && corepack pnpm typecheck && corepack pnpm test`。

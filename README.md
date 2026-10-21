# SYAOCode

TypeScript 原生、模型中立、可嵌入、可审计的 coding-agent harness 库 + 参考 CLI。

**当前状态：v0.1 内部版（M0+M1），未发布。**

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`code/`](code/) | 源码 monorepo（pnpm workspace，五包：core / providers / tools / testing / cli），独立可运行 |
| [`code/README.md`](code/README.md) | 源码总览、命令、发布就绪度与设计不变量 |
| [`code/docs/COMMANDS.md`](code/docs/COMMANDS.md) | `syao` 命令与 TUI 交互完整手册 |
| [`code/docs/TEST-REPORT-v0.1.md`](code/docs/TEST-REPORT-v0.1.md) | v0.1 测试报告 |
| [`document/`](document/) | 项目文档集：立项、预研、需求（SRS）、业务规则、概要/详细设计、错误体系、测试计划、对外交付，以及单文件合并版 |
| [`document/SYAOCode.md`](document/SYAOCode.md) | 同上文档集的单文件版本 |

## 快速开始

需要 Node.js 22 LTS+ 与 pnpm 12。

```bash
cd code                      # ← 先进入 code/，它是 monorepo 根
corepack pnpm install        # 安装依赖
corepack pnpm test           # 跑测试
corepack pnpm start          # 启动参考 CLI（TUI）
```

`corepack pnpm start -- --no-boot` 可跳过启动动画；不配任何密钥时内置 mock provider 可离线跑通全链路。

## 包一览

| 包 | 内容 |
| --- | --- |
| `@syaocode/core` | 内核：消息模型、Runtime 抽象、事件流、agent 循环、权限引擎、79 码错误注册表、配置分层、会话存储、脱敏 |
| `@syaocode/providers` | OpenAI Chat Completions 适配器 + Anthropic Messages 原生适配器（SSE 流式） |
| `@syaocode/tools` | read / write / edit / glob / grep / bash（先读后写围栏、唯一匹配编辑、.gitignore 感知检索） |
| `@syaocode/testing` | MemoryRuntime、MockProvider、provider 合约套件 |
| `syaocode`（CLI） | 参考命令行：权限三档、斜杠命令、纯 ANSI TUI（启动动画 + 常驻界面 + 指令联想） |

## 设计不变量（不可破坏）

- Deny > ask > allow；**任何模型输出都不能把 deny 提升为 allow**。
- 每个 `tool_use` 恰好对应一个 `tool_result`，中断时亦如此。
- 跨包边界只抛 `SyaoError`，用 `SyaoError.is()` 判定，不用 `instanceof`。
- 错误码格式 `SY-<domain>-<seq>`。

## 许可

Apache-2.0，见 [LICENSE](code/LICENSE)。

本项目与 Anthropic、OpenAI、Google、DeepSeek 等模型厂商无隶属关系，相关名称仅用于说明兼容性。

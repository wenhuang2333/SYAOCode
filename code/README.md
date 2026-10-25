# SYAOCode

TypeScript coding-agent harness library + reference CLI. Model-neutral, embeddable, auditable.

**Status: v0.2-dev — trusted foundation + Evidence MVP, not published.** The kernel is host-agnostic (Node capabilities live in `@syaocode/node`), the event stream is replayable (contract v2), and completed runs carry tool receipts, automatic verification and a deterministic claim linter. See `docs/V0.2-REPORT-ALIGNMENT.md` for the evaluation-report mapping and the remaining roadmap.

## What's in v0.2-dev

| Package | Contents |
| --- | --- |
| `@syaocode/core` | Kernel: content-block message model, injected Runtime (no Node builtins), event contract v2 (`seq`/`runId`/`turnId`/`causationId`, lifecycle + approval + receipt events), agent loop (streaming, batching, abort, limits, BR-011 loop detection), permission engine (deny>ask>allow, read-path fence, sensitive-path list, source-checked dangerous library), Evidence MVP (tool receipts, content-addressed outputs, verification discovery, claim linter, verdict), 79-code error registry, Zod config layering, append-only session stores with writer lock, redaction at tool-result/session/log boundaries |
| `@syaocode/node` | Node.js host runtime (`nodeRuntime`), SHA-256 helper and content-addressed evidence store (`createFileReceiptStore`) |
| `@syaocode/providers` | OpenAI Chat Completions adapter (DeepSeek-compatible) + native Anthropic Messages adapter; SSE streaming, normalized events, error mapping |
| `@syaocode/tools` | read / write / edit / glob / grep / bash with read-before-write fencing (BR-004), unique-match edits (BR-005), .gitignore-aware search, restricted shell, bash exit-code metadata |
| `@syaocode/testing` | MemoryRuntime (fully in-memory), MockProvider (scripted), provider contract suite (G2: same suite over all providers) |
| `syaocode` (CLI) | Three permission tiers, in-conversation hot switching, pure-ANSI TUI + readline REPL, `-p`/`exec`, `doctor`/`config`/`verify init`, automatic verification in print mode (after `verify init` pins the commands; `--no-verify` to opt out), JSON schemaVersion 2 with `verdict`/`claims`, exit codes 0/1/2/3/4/5/6/130 |

**开箱默认**：不配任何东西即可 `syao` 直接对话（内置 mock 离线跑通全链路）；配好模型后**交互与 `-p`/`exec` 使用同一套解析顺序**（`--model` > `SYAO_MODEL` > `~/.syaocode/config.json` > mock）。默认权限档为**默认档**（读免确认，写/删/执行仍审批，规范 FR-041 的 default），`--permission-mode strict` 可回到逐条确认；系统提示自动注入工作目录/平台/日期/运行载体/**当前模型身份**，模型能如实回答"你是什么模型"；`/setup` 会按模型名与请求地址自动预填档案名、协议与认证字段，回车即接受。

**双语 CLI**：默认英语，`/language` 可切到中文（写入 `~/.syaocode/config.json`，切换后立即退出、下次启动生效）；界面文案/面板/向导/状态栏/错误提示全部随语言切换，两种语言互不混杂。TUI 指令联想层位于输入框**下方**；启动动画期间按任意键立即跳过。

Out of v0.1 scope (per WBS): 自动压缩、MCP、决策层 (JEV)、三角色编排、/goal。（原计划的 Ink 式 TUI 已在 v0.1 内以零依赖纯 ANSI 方式交付。）

系统提示会自动注入工作目录/平台/日期 + 用户级 `~/.syaocode/AGENTS.md` + 仓库根 `AGENTS.md`（缺失回退 `CLAUDE.md`，`SYAO_INSTRUCTION_FILES` 可配置）。真实模型链路（OpenAI ChatCompletion 网关）已完成配置向导、工具调用、流式思考、权限审批与费用展示的端到端验证，详见 `docs/TEST-REPORT-v0.1.md` §11。

## Commands

**必须在 `code/` 目录内运行**（本仓库自身是 monorepo 根）。若在其上层目录运行 pnpm，pnpm 会向上层查找 package.json 并安装无关项目的依赖（例如误装到家目录的其他项目），导致 `Command "tsx" not found`。

```bash
cd code                                        # ← 先进入本目录
corepack pnpm install                          # install (Node >= 22 required)
corepack pnpm typecheck                        # tsc --noEmit across packages (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess)
corepack pnpm test                               # vitest across packages
corepack pnpm test:evals                         # 10-task deterministic eval harness (no keys needed)
corepack pnpm lint:registry                      # error-registry governance checks
corepack pnpm lint:core                          # kernel purity: no node: imports in @syaocode/core

# CLI（开发运行形态；TUI 启动动画 + 常驻界面）：
corepack pnpm start                             # 等价于 exec tsx packages/cli/src/main.ts
corepack pnpm start --no-boot                   # 跳过启动动画
corepack pnpm exec tsx packages/cli/src/main.ts --version
corepack pnpm exec tsx packages/cli/src/main.ts doctor
corepack pnpm exec tsx packages/cli/src/main.ts verify init
corepack pnpm exec tsx packages/cli/src/main.ts -p "hello" --output-format stream-json
corepack pnpm exec tsx packages/cli/src/main.ts -p "fix it" --no-verify
corepack pnpm exec tsx packages/cli/src/main.ts -p "fix it" --max-total-tokens 200000
```

依赖构建脚本说明：pnpm ≥10 默认拦截依赖的 postinstall，本仓库已在 `pnpm-workspace.yaml` 放行 esbuild（`allowBuilds`）；若新增带安装脚本的依赖，运行 `corepack pnpm approve-builds` 审批。

## Publish readiness（面向未来的 npm 发布）

v0.1 内部版不发布，但打包链路已就绪并离线验证：

- **构建**：每包 `tsc -p tsconfig.build.json` 产出 `dist/`（ESM JS + d.ts）；根 `corepack pnpm build` 按依赖分层构建（core → node → providers/tools/testing → cli）。源码相对 import 一律带 `.js` 后缀（Node ESM 标准），tsc 用 `rewriteRelativeImportExtensions` 兜底。
- **exports 双态**：开发态 `exports` 指向 `./src/*.ts`（workspace 内部直用 TS 源，vitest/tsx 友好）；`pnpm publish`/`pnpm pack` 自动应用 `publishConfig.exports` 切到 `./dist/*.js`（含 `types` 条件）。`workspace:*` 依赖在打包时改写为真实版本号。
- **CLI**：`bin` 为 `syaocode` 与 `syao` 两个名字，均指向带 shebang 的 `dist/main.js`；`files` 只收 `dist/` 与 `LICENSE`；`publishConfig.access: public`（`@syaocode/*` 作用域包必须显式 public，否则发布失败）。
- **离线验证**（发布前可重复执行）：五包 `pnpm pack` → 干净目录 `file:` 安装（用 `pnpm-workspace.yaml` overrides 模拟 registry）→ 纯 Node 实测 `syaocode --version` / `doctor` / mock `-p` 回合 / 管道 REPL / `import '@syaocode/core'` 全部通过。

正式发布流程（先测试后上传，全部通过才允许发布）：

```bash
cd code
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test && corepack pnpm test:evals   # 必须全绿
corepack pnpm build
# 按依赖顺序发布：core → node → providers/tools/testing → cli（CLI 依赖前五者，逆序会解析失败）
for p in core node providers tools testing cli; do (cd packages/$p && corepack pnpm publish --access public); done
```

> 注意：`@syaocode/testing` 是 CLI 的运行时依赖（`mock` provider 的 MockProvider 属于产品功能），其主入口不依赖 vitest（合约套件在 `./contract` 子路径，仅开发用）。

## Design invariants (do not break)

- Deny > ask > allow; **no model output can upgrade a deny** (BR-001/026/027).
- Every `tool_use` gets exactly one `tool_result`, even on abort (BR-009).
- Only `SyaoError` crosses boundaries; identify with `SyaoError.is()`, never `instanceof` (BR-025).
- Error codes: `SY-<domain>-<seq>`; **SY-DEC-007 is an intentional gap** — never fill it.
- All IO goes through the injected Runtime (ADR-03); core depends on nothing but zod.
- Zod is the single schema source (ADR-07); `exports` are ESM-only (ADR-08).

Docs live outside this repo (`../document/SYAOCode/`). Test report: `docs/TEST-REPORT-v0.1.md`. v0.2 report alignment: `docs/V0.2-REPORT-ALIGNMENT.md`.

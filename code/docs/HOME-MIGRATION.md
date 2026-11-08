# 数据目录迁移（SYAOCode → LIWENCode）

> 代码位置：`code/packages/cli/src/model-config.ts`（`resolveDataHome` / `migrateLegacyHome` / `ensureLiwenHome`）
> 测试：`code/packages/cli/test/home-migration.test.ts`（15 例）
> 结论：**改名不丢数据**——旧目录只复制不移动，迁移幂等，失败回滚并保留旧目录。

---

## 1. 背景

SYAOCode → LIWENCode 改名后，用户数据目录从 `~/.syaocode` 改为 `~/.liwencode`，环境变量从 `SYAOCODE_HOME` 改为 `LIWENCODE_HOME`。已有用户的模型档案、密钥（`env`，0600）、会话与用量账本都在旧目录里；直接切新目录等于静默丢配置，因此必须有一次性迁移。

## 2. 数据目录解析（优先级从高到低）

| 优先级 | 来源 | 结果 |
| --- | --- | --- |
| 1 | `LIWENCODE_HOME` | 直接作为数据目录（`~` 会展开） |
| 2 | `SYAOCODE_HOME`（旧变量，兼容） | 直接作为数据目录，并向 stderr 输出一条弃用提示 |
| 3 | 默认 | `~/.liwencode`；若旧目录 `~/.syaocode` 存在则先做一次性迁移 |

- **唯一写入目录**：解析结果就是唯一的读写目录（`config.json`、`env`、`sessions/`、`usage/`、`evidence/`、`AGENTS.md` 全部跟随）。
- 显式环境变量优先于一切：设置了 `LIWENCODE_HOME` 时不做任何目录搬迁；设置了 `SYAOCODE_HOME`（且没有新变量）时沿用该目录，只提示改用新变量——用户显式配置的位置不擅自搬动。
- 显式传入 `home` 参数（测试/嵌入场景）时按旧语义拼 `<home>/.liwencode`，与环境变量无关。

## 3. 迁移流程（仅默认目录场景）

`~/.liwencode` 不存在 且 `~/.syaocode` 存在时：

1. 复制整棵目录树到兄弟临时目录 `~/.liwencode.migrating-<pid>-<ts>-<rand>`；
2. 在临时目录写入迁移标记 `.migrated-from-syaocode.json`（`migratedAt` / `source` / `destination` / `mode: "copy"`）；
3. `rename` 临时目录 → `~/.liwencode`（同文件系统原子完成，不会暴露半成品）。

保证：

- **复制而非移动**：旧目录 `~/.syaocode` 自始至终原样保留，旧版本可随时降级；
- **幂等**：`~/.liwencode` 已存在（含上次已迁移）时直接使用，不复制、不覆盖、不报错；重复启动无副作用；
- **失败回滚**：复制/写标记/改名任一步失败 → 删除临时目录，**不留下半成品新目录**；继续使用旧目录（数据完好），并返回结构化告警 `home-migration-failed`（含原因），由 `main.ts` 打印到 stderr；
- **权限保持**：复制时逐个文件 `chmod` 到源权限，`env` 文件迁移后仍是 `0600`；
- **符号链接**：按链接原样重建，不 dereference；
- **可注入**：`fs` / `home` / `env` / `now` 全部可注入（`HomeOptions`），模块 `import` 时零副作用（不做 IO、不建目录）。

## 4. 失败与告警码

| code | 含义 | 行为 |
| --- | --- | --- |
| `legacy-env-var`（notice） | 使用了 `SYAOCODE_HOME` | 继续使用该目录，提示改用 `LIWENCODE_HOME` |
| `home-migration-failed`（warning） | 复制/写标记/改名失败 | 回退旧目录，旧数据不动，`cause` 带原始错误 |
| `home-migration-cleanup-failed`（warning） | 回滚时临时目录清理失败 | 追加告警（不掩盖主错误） |
| `home-migration-raced`（warning） | 并发进程刚完成迁移 | 使用对方已完成的完整新目录 |
| `home-target-not-directory` / `home-legacy-not-directory`（warning） | 路径类型异常 | 回退/跳过，不破坏数据 |

## 5. 测试覆盖（15 例）

- 旧目录存在 → 复制成功、内容完整、**旧目录仍在**、标记含时间与来源；
- `env` 文件迁移后权限仍为 `0600`；
- 旧+新并存 → 新目录优先、不覆盖；
- 重复调用幂等（不重复复制、mtime 不变、无临时目录残留）；
- 复制失败（注入 `EACCES`）→ 回滚、无半成品新目录、旧目录可读、告警可见；
- `ensureLiwenHome` 失败后 `liwenHome()` 回退旧目录 / 成功后指向新目录；
- `SYAOCODE_HOME` 兼容（作为数据目录 + 提示，不搬迁）；
- `LIWENCODE_HOME` 优先于 `SYAOCODE_HOME`；
- 无旧目录时不迁移不报错；注入面下无 import 期副作用。

/**
 * 桌面端文案目录（`27` FR-N-037 / `doc 26` §2.1）。
 *
 * 为什么在 `apps/desktop` 而不是 `packages/ui`：
 *  - `packages/ui` 是**共享组件包**（时间线、输入区、审批卡），它的文案键集已经
 *    中英对等（见 `packages/ui/src/i18n.ts`）；
 *  - 桌面端外壳（Git 侧栏、会话详情、各设置页）是**本项目独有**的界面，
 *    把它们塞进共享包会污染其它消费方。
 *
 * 规则（与 `packages/ui/src/i18n.ts` 一致，不另立一套）：
 *  1. **所有**面向用户的字符串走这里，组件里不出现裸中文字面量；
 *  2. 中英**键集完全相同**——由 TypeScript 的 `Messages` 类型保证，
 *     再由 `i18n.test.ts` 的运行时断言兜底（防止有人用 `as` 绕过类型）；
 *  3. 未知键**显式可见**（`⟦path⟧`），不静默回退成空串；
 *  4. 插值用 `{name}` 占位，由 `t()` 替换——不允许在组件里手工拼字符串，
 *     否则译文无法调整语序。
 *
 * 尚未抽取的模块（`git-sidebar` / `detail-panel` 等）继续用中文，
 * 由设置页如实说明；**不假装已抽取完**。
 */

export type Lang = 'en' | 'zh';

export interface DesktopMessages {
  readonly shell: {
    /** 标签：本地命令。 */
    readonly tag: string;
    /** 副标签：未发送给模型。 */
    readonly hint: string;
    /** 区域的无障碍名称。 */
    readonly ariaLabel: string;
    /** 执行中。 */
    readonly running: string;
    /** 成功摘要。 */
    readonly ok: string;
    /** 失败摘要（无详情）。 */
    readonly failed: string;
    /** 失败摘要（带原因）。 */
    readonly failedWith: string;
    /** 失败摘要（带退出码）。 */
    readonly failedExit: string;
    /** 超时摘要。 */
    readonly timeout: string;
    /** 被拒摘要。 */
    readonly denied: string;
    /** 被拒摘要（带原因）。 */
    readonly deniedWith: string;
    /** 没有输出时的占位。 */
    readonly emptyOutput: string;
    /** 输出被截断。 */
    readonly truncated: string;
    /** stderr 分隔标记。 */
    readonly stderrSeparator: string;
    /** 被拒时的补充说明。 */
    readonly deniedNote: string;
    /** 退出码与耗时。 */
    readonly meta: string;
  };
  readonly git: {
    /** tabs */
    readonly tabs: {
      /** 变更 */
      readonly changes: string;
      /** 提交图 */
      readonly graph: string;
      /** 分支 */
      readonly branches: string;
      /** 上传 */
      readonly upload: string;
    };
    /** panel */
    readonly panel: {
      /** Git 侧栏 */
      readonly ariaLabel: string;
      /** Git 面板 */
      readonly tabsLabel: string;
      /** 刷新 Git 状态 */
      readonly refreshAria: string;
      /** 刷新 */
      readonly refreshTitle: string;
      /** 关闭 Git 侧栏 */
      readonly closeAria: string;
      /** 关闭 */
      readonly closeTitle: string;
    };
    /** header */
    readonly header: {
      /** 游离 */
      readonly detachedBadge: string;
      /** 游离 HEAD 分支位文案 */
      readonly detachedHead: string;
      /** 尚未读取 */
      readonly branchNotLoaded: string;
      /** 联网状态：{label} */
      readonly onlineSr: string;
      /** 认证状态：{label} */
      readonly authSr: string;
    };
    /** status */
    readonly status: {
      /** 新增 */
      readonly added: string;
      /** 修改 */
      readonly modified: string;
      /** 删除 */
      readonly deleted: string;
      /** 重命名 */
      readonly renamed: string;
      /** 未跟踪 */
      readonly untracked: string;
      /** 冲突 */
      readonly conflicted: string;
      /** 未知状态 */
      readonly unknown: string;
    };
    /** group */
    readonly group: {
      /** 已暂存 */
      readonly staged: string;
      /** 未暂存 */
      readonly unstaged: string;
      /** 未跟踪 */
      readonly untracked: string;
      /** 无 */
      readonly empty: string;
    };
    /** file */
    readonly file: {
      /** 不可统计 */
      readonly statUnavailable: string;
      /** 已暂存 */
      readonly whereStaged: string;
      /** 未暂存 */
      readonly whereUnstaged: string;
      /** 未跟踪 */
      readonly whereUntracked: string;
      /** {path}，{status}，{where}，不可统计行数 */
      readonly ariaUnavailable: string;
      /** {path}，{status}，{where}，新增 {added} 行，删除 {removed} 行 */
      readonly ariaChanged: string;
      /** 暂存 */
      readonly stageAction: string;
      /** 取消暂存 */
      readonly unstageAction: string;
      /** {action} {path} */
      readonly stageAria: string;
    };
    /** summary */
    readonly summary: {
      /** 工作区未提交改动 · 尚未读取 */
      readonly notLoaded: string;
      /** 工作区未提交改动 · 0 个文件 */
      readonly empty: string;
      /** 工作区未提交改动 · {files} 个文件 · 统计不完整 */
      readonly incomplete: string;
      /** 工作区未提交改动 · {files} 个文件 · +{added} -{removed} */
      readonly withCounts: string;
      /** {files} 个文件 */
      readonly badgeFiles: string;
    };
    /** scope */
    readonly scope: {
      /** 工作区口径：索引区里将要提交的内容（已暂存差异）。 */
      readonly staged: string;
      /** 工作区口径：与索引区相比的未暂存差异（未跟踪文件按工作区内容计算）。 */
      readonly worktree: string;
    };
    /** diff */
    readonly diff: {
      /** 二进制文件，无法显示文本 diff */
      readonly binary: string;
      /** diff 头部：二进制文件 */
      readonly binaryBadge: string;
      /** 差异过长，只显示前一部分 */
      readonly truncated: string;
      /** 该文件在当前口径下没有文本差异 */
      readonly noText: string;
      /** {path} 的只读 diff */
      readonly aria: string;
      /** 查看 {path} 的只读 diff */
      readonly openAria: string;
      /** 收起 {path} 的只读 diff */
      readonly collapseAria: string;
      /** 读取 diff 失败：{message} */
      readonly readFailed: string;
      /** 正在读取只读 diff */
      readonly readingAria: string;
      /** 读取中 */
      readonly reading: string;
      /** 不可用 */
      readonly unavailable: string;
      /** 正在读取该文件的工作区口径 diff… */
      readonly readingBody: string;
      /** 未能读取该文件的工作区口径 diff（文件可能已被删除或移动） */
      readonly unavailableBody: string;
    };
    /** changes */
    readonly changes: {
      /** 输出已截断，文件列表不完整。 */
      readonly truncated: string;
      /** 工作区没有未提交改动。 */
      readonly empty: string;
      /** 尚未读取工作区状态（不能说"没有改动"，那是没有根据的断言）。 */
      readonly notLoaded: string;
    };
    /** hooks */
    readonly hooks: {
      /** 钩子状态尚未读取 */
      readonly notLoaded: string;
      /** 没有可执行的提交钩子 */
      readonly none: string;
      /** 将运行 {count} 个钩子（{names}） */
      readonly willRun: string;
      /** 存在但不可执行（Git 不会运行）：{names} */
      readonly inactive: string;
    };
    /** commit */
    readonly commit: {
      /** 提交已暂存改动 */
      readonly aria: string;
      /** 提交信息 */
      readonly label: string;
      /** 填写提交信息 */
      readonly placeholder: string;
      /** 提交已暂存改动 */
      readonly submit: string;
      /** 正在提交… */
      readonly submitting: string;
      /** 未知大小 */
      readonly unknownSize: string;
      /** 跳过钩子（--no-verify，会记审计） */
      readonly skipHooks: string;
      /** 允许空提交（--allow-empty） */
      readonly allowEmpty: string;
      /** 默认拒绝空提交：没有已暂存文件时，需勾选“允许空提交”才能提交。 */
      readonly emptyHint: string;
      /** 以下已暂存文件超过 {size}： */
      readonly largeFiles: string;
      /** 只提示，不阻止提交。 */
      readonly largeFilesNote: string;
      /** 提交属于本地写操作：先暂存，再提交；不提供强制推送。 */
      readonly localNote: string;
      /** 提交已完成。 */
      readonly done: string;
      /** 无签名提交完成。 */
      readonly unsignedDone: string;
      /** 提交失败：{message} */
      readonly failed: string;
    };
    /** signing */
    readonly signing: {
      /** 提交签名失败 */
      readonly title: string;
      /** 签名失败不会自动降级。请选择一条路径： */
      readonly hint: string;
      /** 重试 */
      readonly retry: string;
      /** 用同样的参数再提交一次；不会自动重试。 */
      readonly retryHint: string;
      /** 无签名提交 */
      readonly unsigned: string;
      /** 本次提交不签名（--no-gpg-sign），会记审计。 */
      readonly unsignedHint: string;
      /** 取消 */
      readonly cancel: string;
      /** 不做任何提交，保留已填写的提交信息。 */
      readonly cancelHint: string;
      /** 取消会保留提交信息，不会执行任何提交。 */
      readonly cancelNote: string;
    };
    /** ahead */
    readonly ahead: {
      /** 领先/落后未知 */
      readonly unknown: string;
      /** 领先 {ahead} · 落后 {behind} */
      readonly value: string;
    };
    /** unknownWord */
    readonly unknownWord: {
      /** 未知 */
      readonly unknown: string;
    };
    /** auth */
    readonly auth: {
      /** 认证状态未知 */
      readonly unknown: string;
      /** 未配置凭据 */
      readonly notConfigured: string;
      /** 凭据已配置，尚未校验 */
      readonly configuredNotVerified: string;
      /** 认证就绪 · {method}{account} */
      readonly ready: string;
      /** （{account}） */
      readonly account: string;
      /** 浏览器授权 */
      readonly methodOauth: string;
      /** 系统 SSH 凭据 */
      readonly methodSshAgent: string;
      /** SSH 密钥 */
      readonly methodSshKey: string;
      /** 访问令牌 */
      readonly methodToken: string;
      /** 无凭据 */
      readonly methodNone: string;
    };
    /** oauth */
    readonly oauth: {
      /** 点开始后按提示在浏览器完成授权，无需填 client_id。 */
      readonly hintReady: string;
      /** 需要填入你自己的 OAuth App client_id（开源仓库不内置）。client_id 只保存在本页内存，不落盘。 */
      readonly hintClientId: string;
      /** 该厂商暂不支持设备码流程，请改用 SSH 凭据或访问令牌。 */
      readonly hintUnsupported: string;
      /** 等待浏览器授权… */
      readonly pending: string;
      /** 授权服务器要求放慢轮询，已加大间隔继续等待… */
      readonly slowDown: string;
      /** 授权成功 */
      readonly ready: string;
      /** 你在浏览器拒绝了授权 */
      readonly denied: string;
      /** 设备码已过期 */
      readonly expired: string;
      /** 你在浏览器拒绝授权；如需重试请重新开始授权流程。 */
      readonly failureDenied: string;
      /** 设备码已过期，请重新开始（过期后旧的设备码不可再用）。 */
      readonly failureExpired: string;
      /** 已过期 */
      readonly alreadyExpired: string;
      /** 剩余 {seconds} 秒 */
      readonly remainingSeconds: string;
      /** 剩余 {minutes} 分 {seconds} 秒 */
      readonly remainingMinutes: string;
      /** 该厂商的浏览器授权当前不可用：开源仓库不内置 client_id，请填入你自己的 OAuth App client_id，或改用 SSH / 访问令牌。 */
      readonly errorUnavailable: string;
      /** 授权仍在进行中，请稍候再试。 */
      readonly errorPending: string;
      /** 浏览器授权失败 */
      readonly errorFailed: string;
      /** 浏览器授权失败：{message} */
      readonly errorFailedWith: string;
      /** 授权厂商 */
      readonly providersLabel: string;
      /** OAuth App client_id */
      readonly clientIdLabel: string;
      /** 填入你自己的 OAuth App client_id */
      readonly clientIdPlaceholder: string;
      /** client_id 只保存在本页内存，刷新即清空；不会写入磁盘，也不会发给除授权服务器以外的任何地方。 */
      readonly clientIdNote: string;
      /** 开始浏览器授权 */
      readonly start: string;
      /** 在浏览器中打开按钮 */
      readonly openButton: string;
      /** 正在申请设备码… */
      readonly starting: string;
      /** 复制设备码 */
      readonly copyCode: string;
      /** 在系统浏览器中打开授权页 */
      readonly openTitle: string;
      /** 主进程未提供打开外部链接的通道 */
      readonly openUnavailableTitle: string;
      /** 授权地址与设备码需要你自己核对；本应用不会自动打开浏览器，也不会代填设备码。 */
      readonly openNote: string;
      /** 主进程未提供打开外部链接的通道：请手动复制上面的授权地址到浏览器打开。 */
      readonly openUnavailableNote: string;
      /** 正在等待第一次轮询… */
      readonly waitingFirst: string;
      /** {status}（第 {count} 次检查） */
      readonly pollStatus: string;
      /** 授权成功{account}，已重新读取认证状态。 */
      readonly success: string;
      /** （账号 {account}） */
      readonly successAccount: string;
      /** 授权未完成，请看下面的错误信息。 */
      readonly notCompleted: string;
      /** {remaining}（最多检查 {limit} 次） */
      readonly remaining: string;
      /** 取消授权 */
      readonly cancel: string;
      /** 重新开始 */
      readonly restart: string;
      /** 设备码 */
      readonly deviceCode: string;
      /** 授权地址 */
      readonly verificationUri: string;
      /** 浏览器授权（设备码） */
      readonly title: string;
      /** 运行时未提供轮询接口 */
      readonly noPollApi: string;
      /** 已检查 {limit} 次仍未完成授权，已停止轮询。 */
      readonly pollLimit: string;
      /** 请先填入你自己的 OAuth App client_id。 */
      readonly needClientId: string;
    };
    /** online */
    readonly online: {
      /** 未知（点击“开始预检”检查连接） */
      readonly unknown: string;
      /** 未知（预检结果里的短文案） */
      readonly unknownShort: string;
      /** 在线 */
      readonly online: string;
      /** 离线 */
      readonly offline: string;
    };
    /** branch */
    readonly branch: {
      /** 远端 {name} */
      readonly remote: string;
      /** （当前） */
      readonly current: string;
      /** 分支列表里的当前徽标 */
      readonly currentBadge: string;
      /** 本地分支 */
      readonly localGroup: string;
      /** 远端分支 */
      readonly remoteGroup: string;
      /** 上游 {name} */
      readonly upstream: string;
      /** 切换 */
      readonly switch: string;
      /** 新建分支 */
      readonly newLabel: string;
      /** 分支名 */
      readonly newPlaceholder: string;
      /** 创建分支 */
      readonly create: string;
      /** 当前处于游离 HEAD，切换分支前请先提交或保留改动。 */
      readonly detachedNote: string;
    };
    /** upload */
    readonly upload: {
      /** 全部未提交改动 */
      readonly scopeAll: string;
      /** 仅本会话改动 */
      readonly scopeSession: string;
      /** 上传范围 */
      readonly scopeLabel: string;
      /** 提交信息 */
      readonly messageLabel: string;
      /** 填写本次上传的提交信息 */
      readonly messagePlaceholder: string;
      /** 生成提交信息 */
      readonly generate: string;
      /** 正在生成… */
      readonly generating: string;
      /** 按已暂存改动生成 Conventional Commit 文案；生成是只读的，不会提交。 */
      readonly generateNote: string;
      /** 输入框已有内容，用生成的提交信息替换吗？ */
      readonly generateReplace: string;
      /** 生成没有返回结果，请手动填写。 */
      readonly generateNoResult: string;
      /** 模型不可用，已填入确定性兜底文案{reason}；可直接改写后提交。 */
      readonly generateFallback: string;
      /** 兜底原因的外层括号（中文全角 / 英文半角）。 */
      readonly generateFallbackReason: string;
      /** 改动较多，生成时 diff 已截断；建议核对后再提交。 */
      readonly generateTruncated: string;
      /** 已根据已暂存改动生成，可直接改写。 */
      readonly generateOk: string;
      /** 生成失败：{message} */
      readonly generateFailed: string;
      /** 预检并准备确认 */
      readonly preflightAndConfirm: string;
      /** 二次确认 */
      readonly confirmTitle: string;
      /** 上传会把本地代码送出本机。请核对下面每一项，必要时返回修改。 */
      readonly confirmNote: string;
      /** 确认上传 */
      readonly confirmButton: string;
      /** 取消 */
      readonly cancel: string;
      /** 正在提交并上传…（commit → push） */
      readonly uploading: string;
      /** 上传成功 */
      readonly successTitle: string;
      /** 提交 sha */
      readonly shaLabel: string;
      /** 复制提交 sha */
      readonly copySha: string;
      /** 远端地址不在此处自动打开；如需查看，请自行复制到浏览器。 */
      readonly remoteNotAuto: string;
      /** 完成 */
      readonly done: string;
      /** 上传失败（{code}） */
      readonly failedTitle: string;
      /** 返回 */
      readonly back: string;
      /** 上传结果不完整，请重试。 */
      readonly incomplete: string;
      /** 1 · 选择远端 */
      readonly step1: string;
      /** 2 · 认证状态 */
      readonly step2: string;
      /** 3 · 预检 */
      readonly step3: string;
      /** 4 · 范围与提交信息 */
      readonly step4: string;
      /** 远端 */
      readonly remoteLabel: string;
      /** 仓库没有配置远端。请先在仓库中添加远端后再上传。 */
      readonly noRemote: string;
      /** 认证状态 */
      readonly authStatusLabel: string;
      /** 此远端尚未配置凭据。可使用系统 SSH 凭据，或粘贴访问令牌（令牌只写不读回，提交后立即清空）。 */
      readonly noCredentialNote: string;
      /** 访问令牌 */
      readonly tokenLabel: string;
      /** 粘贴访问令牌 */
      readonly tokenPlaceholder: string;
      /** 保存并验证 */
      readonly saveToken: string;
      /** 断开连接 */
      readonly disconnect: string;
      /** 使用 SSH 凭据按钮 */
      readonly useSshAgent: string;
      /** 主进程尚未提供凭据通道，令牌不会被保存。请改用 SSH 凭据或等待凭据桥接上线。 */
      readonly noCredentialBridge: string;
      /** 上传前必须重新预检：脏工作区、领先/落后、分叉、远端可写性、网络。 */
      readonly preflightNote: string;
      /** 开始预检 */
      readonly startPreflight: string;
      /** 分支 */
      readonly branchLabel: string;
      /** 领先/落后 */
      readonly aheadBehindLabel: string;
      /** 联网 */
      readonly onlineLabel: string;
      /** 文件数 */
      readonly filesLabel: string;
      /** 行数 */
      readonly linesLabel: string;
      /** 范围 */
      readonly scopeFieldLabel: string;
      /** 提交信息 */
      readonly confirmMessageLabel: string;
    };
    /** failure */
    readonly failure: {
      /** 未配置凭据 */
      readonly authRequiredTitle: string;
      /** 去配置凭据 */
      readonly authRequiredAction1: string;
      /** 改用 SSH 凭据 */
      readonly authRequiredAction2: string;
      /** 凭据被远端拒绝 */
      readonly authRejectedTitle: string;
      /** 重新输入令牌 */
      readonly authRejectedAction1: string;
      /** 检查令牌权限范围 */
      readonly authRejectedAction2: string;
      /** 网络不可达 */
      readonly offlineTitle: string;
      /** 检查网络后重试 */
      readonly offlineAction: string;
      /** 远端有新提交（分叉） */
      readonly divergedTitle: string;
      /** 先拉取再上传 */
      readonly divergedAction1: string;
      /** 上传到新分支 */
      readonly divergedAction2: string;
      /** 取消 */
      readonly cancelAction: string;
      /** 提交或推送被拒绝（无改动 / 无 upstream / 钩子或远端策略） */
      readonly noChangeTitle: string;
      /** 查看脱敏后的远端消息 */
      readonly noChangeAction1: string;
      /** 检查远端与分支设置 */
      readonly noChangeAction2: string;
      /** 返回重新选择范围 */
      readonly noChangeAction3: string;
      /** 操作被安全边界拦截 */
      readonly blockedTitle: string;
      /** 返回重新选择参数 */
      readonly blockedAction: string;
      /** 上传失败 */
      readonly unknownTitle: string;
    /** 上传没有返回完整结果（本地判定，不是 DHP 错误码）。 */
    readonly incompleteTitle: string;
    readonly incompleteAction: string;
      /** 重试 */
      readonly unknownAction1: string;
      /** 改范围 */
      readonly unknownAction2: string;
      /** 去配置凭据 */
      readonly unknownAction3: string;
    };
    /** graph */
    readonly graph: {
      /** 窗口外的父提交以虚线表示，还有更多历史。 */
      readonly truncated: string;
      /** 仓库还没有提交记录。 */
      readonly empty: string;
      /** 加载更多 */
      readonly loadMore: string;
      /** 提交 {sha}，{subject} */
      readonly rowAria: string;
    };
    /** footer */
    readonly footer: {
      /** 本会话改动见会话详情 → */
      readonly openDetail: string;
      /** 工作区口径与会话口径互不相加。 */
      readonly scopeNote: string;
    };
  };

  readonly detail: {
    /** 6 个分区的标题（顺序固定）。 */
    readonly sections: Readonly<Record<'overview' | 'changes' | 'artifacts' | 'sources' | 'context' | 'capabilities', string>>;
    /** 改动状态的文字说明（颜色之外的第二载体）。 */
    readonly changeStatus: Readonly<Record<'added' | 'modified' | 'deleted' | 'renamed', string>>;
    /** 产出类型。 */
    readonly artifactKind: Readonly<Record<'file' | 'image' | 'patch' | 'report' | 'archive', string>>;
    /** 三个分区的空态。 */
    readonly emptyChanges: string;
    readonly emptyArtifacts: string;
    readonly emptySources: string;
    /** 未知状态（防御性，正常不会出现）。 */
    readonly unknownStatus: string;
    /** 不可统计（**不是 0**）。 */
    readonly unavailableStat: string;
    /** 改动折叠摘要。 */
    readonly changeSummaryZero: string;
    readonly changeSummary: string;
    readonly changeSummaryIncomplete: string;
    /** 改动行的无障碍标签。 */
    readonly changeLineAria: string;
    readonly changeLineAriaUnknown: string;
    readonly changeLineExpanded: string;
    readonly changeLineCollapsed: string;
    /** 产出操作。 */
    readonly actionPreview: string;
    readonly actionCopyPath: string;
    readonly actionReveal: string;
    readonly previewCollapse: string;
    readonly copiedPath: string;
    readonly copyFailed: string;
    readonly previewFailed: string;
    readonly previewFailedWith: string;
    readonly revealFailed: string;
    readonly revealFailedWith: string;
    readonly revealTitle: string;
    readonly revealUnavailableTitle: string;
    readonly reading: string;
    /** 预览的四种不可用原因。 */
    readonly previewBinary: string;
    readonly previewTooLarge: string;
    readonly previewMissing: string;
    readonly previewEmpty: string;
    readonly previewTruncated: string;
    /** 来源可信度。 */
    readonly trustVerified: string;
    readonly trustDeclared: string;
    readonly trustUnverified: string;
    /** 来源出现次数。 */
    readonly sourceCount: string;
    /** 产出的无障碍标签与元信息。 */
    readonly sourceLineAria: string;
    /** diff 的四种不可用原因。 */
    readonly diffBinary: string;
    readonly diffTooLarge: string;
    readonly diffNoSnapshot: string;
    readonly diffDeleted: string;
    readonly diffNoText: string;
    readonly diffTruncatedNote: string;
    readonly diffNotRecorded: string;
    readonly diffReadFailed: string;
    readonly diffReadFailedWith: string;
    readonly diffRuntimeEmpty: string;
    readonly previewRuntimeEmpty: string;
    /** 改动统计的覆盖说明。 */
    readonly coverageFallback: string;
    /** 概览分区的字段名。 */
    readonly overviewTurns: string;
    readonly overviewRequests: string;
    readonly overviewCost: string;
    readonly overviewCacheRead: string;
    readonly overviewTotalTokens: string;
    readonly overviewDuration: string;
    readonly overviewInput: string;
    readonly overviewOutput: string;
    readonly overviewErrors: string;
    readonly overviewNoSession: string;
    readonly overviewCostNote: string;
    readonly overviewWorkspace: string;
    readonly overviewModel: string;
    readonly overviewPermission: string;
    readonly overviewUsageNote: string;
    /** 上下文分区的文案。 */
    readonly contextEstimated: string;
    readonly contextSegmentFallback1: string;
    readonly contextSegmentFallback2: string;
    readonly contextSegmentFallback3: string;
    readonly contextNote: string;
    readonly contextCapacityConfigured: string;
    readonly contextRemaining: string;
    readonly contextNoCompaction: string;
    /** 能力分区的文案。 */
    readonly capabilitiesSubtitle: string;
    readonly capabilityAvailable: string;
    readonly capabilityUnavailable: string;
    readonly capabilityOpenHelp: string;
    /** 还没读到能力清单时的说明（不能断言"MCP 未接入"——那可能已经不成立）。 */
    readonly capabilitiesNotLoaded: string;
    /** 权限模式名称（与内核档位一一对应）。 */
    readonly permissionNames: Readonly<Record<'plan' | 'strict' | 'default' | 'acceptEdits' | 'bypass', string>>;
    /** 分区关闭按钮。 */
    readonly closeAria: string;
    readonly title: string;
    /** 数据口径说明。 */
    readonly changesScopeNote: string;
    /** diff 区域的无障碍名称。 */
    readonly diffAria: string;
    /** 分区折叠标题的无障碍名称。 */
    readonly sectionAria: string;
    readonly sourceTool: string;
    readonly artifactsCount: string;
    readonly sourcesCount: string;
    readonly artifactsNone: string;
    readonly sourcesNone: string;
    readonly changeDiffReading: string;
    readonly changeDiffNoResult: string;
    readonly contextNotCollected: string;
    readonly contextCapacityAdapter: string;
    readonly contextCapacityFallback: string;
    readonly unknownCostNote: string;
    readonly usageTotalsNote: string;
    readonly artifactSizeLabel: string;
    readonly artifactToolLabel: string;
    /** 产出 aria-label 里的"来源工具"后缀。 */
    readonly artifactLineAria: string;
  };
  readonly relative: {
    /** 刚刚（含未来时间戳，避免显示"负几分钟前"）。 */
    readonly justNow: string;
    /** N 分钟前。 */
    readonly minutesAgo: string;
    /** N 小时前。 */
    readonly hoursAgo: string;
    /** N 天前。 */
    readonly daysAgo: string;
  };
  readonly palette: {
    /** 面板标题。 */
    readonly title: string;
    /** 命令面板的无障碍名称。 */
    readonly commandListLabel: string;
    /** 文件面板的无障碍名称。 */
    readonly fileListLabel: string;
    /** 文件列表为空。 */
    readonly noFiles: string;
    /** 没有匹配的命令。 */
    readonly noCommand: string;
    /** 没有匹配的文件。 */
    readonly noFileMatch: string;
    /** 正在读取工作区文件。 */
    readonly loadingFiles: string;
    /** 提示：输入 @ 引用文件。 */
    readonly hint: string;
    /** 键位提示（命令面板 / 文件面板各一句）。 */
    readonly keysCommand: string;
    readonly keysFile: string;
    /** 面板里"命令"与"文件引用"两个分组标题。 */
    readonly groupCommand: string;
    readonly groupFile: string;
    /** 文件引用的副标题。 */
    readonly fileHint: string;
    /** `/help` 插入的完整帮助文本。 */
    readonly helpText: string;
    /** `!` 前缀提示。 */
    readonly shellHint: string;
    /** 每条命令的标题与说明（按命令 id 索引）。 */
    readonly commands: Readonly<Record<PaletteCommandId, { readonly title: string; readonly hint: string }>>;
  };
}

/** 命令面板的命令 id（与 `composer-palette.tsx` 的 `CommandId` 对应）。 */
export type PaletteCommandId = 'new' | 'model' | 'permission' | 'stop' | 'archive' | 'git' | 'detail' | 'usage' | 'help';

const zh: DesktopMessages = {
  git: {
    tabs: {
      changes: '变更',
      graph: '提交图',
      branches: '分支',
      upload: '上传',
    },
    panel: {
      ariaLabel: 'Git 侧栏',
      tabsLabel: 'Git 面板',
      refreshAria: '刷新 Git 状态',
      refreshTitle: '刷新',
      closeAria: '关闭 Git 侧栏',
      closeTitle: '关闭',
    },
    header: {
      detachedBadge: '游离',
      detachedHead: '游离 HEAD',
      branchNotLoaded: '尚未读取',
      onlineSr: '联网状态：{label}',
      authSr: '认证状态：{label}',
    },
    status: {
      added: '新增',
      modified: '修改',
      deleted: '删除',
      renamed: '重命名',
      untracked: '未跟踪',
      conflicted: '冲突',
      unknown: '未知状态',
    },
    group: {
      staged: '已暂存',
      unstaged: '未暂存',
      untracked: '未跟踪',
      empty: '无',
    },
    file: {
      statUnavailable: '不可统计',
      whereStaged: '已暂存',
      whereUnstaged: '未暂存',
      whereUntracked: '未跟踪',
      ariaUnavailable: '{path}，{status}，{where}，不可统计行数',
      ariaChanged: '{path}，{status}，{where}，新增 {added} 行，删除 {removed} 行',
      stageAction: '暂存',
      unstageAction: '取消暂存',
      stageAria: '{action} {path}',
    },
    summary: {
      notLoaded: '工作区未提交改动 · 尚未读取',
      empty: '工作区未提交改动 · 0 个文件',
      incomplete: '工作区未提交改动 · {files} 个文件 · 统计不完整',
      withCounts: '工作区未提交改动 · {files} 个文件 · +{added} -{removed}',
      badgeFiles: '{files} 个文件',
    },
    scope: {
      staged: '工作区口径：索引区里将要提交的内容（已暂存差异）。',
      worktree: '工作区口径：与索引区相比的未暂存差异（未跟踪文件按工作区内容计算）。',
    },
    diff: {
      binary: '二进制文件，无法显示文本 diff',
      binaryBadge: '二进制文件',
      truncated: '差异过长，只显示前一部分',
      noText: '该文件在当前口径下没有文本差异',
      aria: '{path} 的只读 diff',
      openAria: '查看 {path} 的只读 diff',
      collapseAria: '收起 {path} 的只读 diff',
      readFailed: '读取 diff 失败：{message}',
      readingAria: '正在读取只读 diff',
      reading: '读取中',
      unavailable: '不可用',
      readingBody: '正在读取该文件的工作区口径 diff…',
      unavailableBody: '未能读取该文件的工作区口径 diff（文件可能已被删除或移动）',
    },
    changes: {
      truncated: '输出已截断，文件列表不完整。',
      empty: '工作区没有未提交改动。',
      notLoaded: '尚未读取工作区状态。',
    },
    hooks: {
      notLoaded: '钩子状态尚未读取',
      none: '没有可执行的提交钩子',
      willRun: '将运行 {count} 个钩子（{names}）',
      inactive: '存在但不可执行（Git 不会运行）：{names}',
    },
    commit: {
      aria: '提交已暂存改动',
      label: '提交信息',
      placeholder: '填写提交信息',
      submit: '提交已暂存改动',
      submitting: '正在提交…',
      unknownSize: '未知大小',
      skipHooks: '跳过钩子（--no-verify，会记审计）',
      allowEmpty: '允许空提交（--allow-empty）',
      emptyHint: '默认拒绝空提交：没有已暂存文件时，需勾选“允许空提交”才能提交。',
      largeFiles: '以下已暂存文件超过 {size}：',
      largeFilesNote: '只提示，不阻止提交。',
      localNote: '提交属于本地写操作：先暂存，再提交；不提供强制推送。',
      done: '提交已完成。',
      unsignedDone: '本次提交未签名（已记审计）。',
      failed: '提交失败：{message}',
    },
    signing: {
      title: '提交签名失败',
      hint: '签名失败不会自动降级。请选择一条路径：',
      retry: '重试',
      retryHint: '用同样的参数再提交一次；不会自动重试。',
      unsigned: '无签名提交',
      unsignedHint: '本次提交不签名（--no-gpg-sign），会记审计。',
      cancel: '取消',
      cancelHint: '不做任何提交，保留已填写的提交信息。',
      cancelNote: '取消会保留提交信息，不会执行任何提交。',
    },
    ahead: {
      unknown: '领先/落后未知',
      value: '领先 {ahead} · 落后 {behind}',
    },
    unknownWord: {
      unknown: '未知',
    },
    auth: {
      unknown: '认证状态未知',
      notConfigured: '未配置凭据',
      configuredNotVerified: '凭据已配置，尚未校验',
      ready: '认证就绪 · {method}{account}',
      account: '（{account}）',
      methodOauth: '浏览器授权',
      methodSshAgent: '系统 SSH 凭据',
      methodSshKey: 'SSH 密钥',
      methodToken: '访问令牌',
      methodNone: '无凭据',
    },
    oauth: {
      hintReady: '点开始后按提示在浏览器完成授权，无需填 client_id。',
      hintClientId: '需要填入你自己的 OAuth App client_id（开源仓库不内置）。client_id 只保存在本页内存，不落盘。',
      hintUnsupported: '该厂商暂不支持设备码流程，请改用 SSH 凭据或访问令牌。',
      pending: '等待浏览器授权…',
      slowDown: '授权服务器要求放慢轮询，已加大间隔继续等待…',
      ready: '授权成功',
      denied: '你在浏览器拒绝了授权',
      expired: '设备码已过期',
      failureDenied: '你在浏览器拒绝授权；如需重试请重新开始授权流程。',
      failureExpired: '设备码已过期，请重新开始（过期后旧的设备码不可再用）。',
      alreadyExpired: '已过期',
      remainingSeconds: '剩余 {seconds} 秒',
      remainingMinutes: '剩余 {minutes} 分 {seconds} 秒',
      errorUnavailable: '该厂商的浏览器授权当前不可用：开源仓库不内置 client_id，请填入你自己的 OAuth App client_id，或改用 SSH / 访问令牌。',
      errorPending: '授权仍在进行中，请稍候再试。',
      errorFailed: '浏览器授权失败',
      errorFailedWith: '浏览器授权失败：{message}',
      providersLabel: '授权厂商',
      clientIdLabel: 'OAuth App client_id',
      clientIdPlaceholder: '填入你自己的 OAuth App client_id',
      clientIdNote: 'client_id 只保存在本页内存，刷新即清空；不会写入磁盘，也不会发给除授权服务器以外的任何地方。',
      start: '开始浏览器授权',
      openButton: '在浏览器中打开',
      starting: '正在申请设备码…',
      copyCode: '复制设备码',
      openTitle: '在系统浏览器中打开授权页',
      openUnavailableTitle: '主进程未提供打开外部链接的通道',
      openNote: '授权地址与设备码需要你自己核对；本应用不会自动打开浏览器，也不会代填设备码。',
      openUnavailableNote: '主进程未提供打开外部链接的通道：请手动复制上面的授权地址到浏览器打开。',
      waitingFirst: '正在等待第一次轮询…',
      pollStatus: '{status}（第 {count} 次检查）',
      success: '授权成功{account}，已重新读取认证状态。',
      successAccount: '（账号 {account}）',
      notCompleted: '授权未完成，请看下面的错误信息。',
      remaining: '{remaining}（最多检查 {limit} 次）',
      cancel: '取消授权',
      restart: '重新开始',
      deviceCode: '设备码',
      verificationUri: '授权地址',
      title: '浏览器授权（设备码）',
      noPollApi: '运行时未提供轮询接口',
      pollLimit: '已检查 {limit} 次仍未完成授权，已停止轮询。',
      needClientId: '请先填入你自己的 OAuth App client_id。',
    },
    online: {
      unknown: '未知（点击“开始预检”检查连接）',
      unknownShort: '未知',
      online: '在线',
      offline: '离线',
    },
    branch: {
      remote: '远端 {name}',
      current: '（当前）',
      currentBadge: '当前',
      localGroup: '本地分支',
      remoteGroup: '远端分支',
      upstream: '上游 {name}',
      switch: '切换',
      newLabel: '新建分支',
      newPlaceholder: '分支名',
      create: '创建分支',
      detachedNote: '当前处于游离 HEAD，切换分支前请先提交或保留改动。',
    },
    upload: {
      scopeAll: '全部未提交改动',
      scopeSession: '仅本会话改动',
      scopeLabel: '上传范围',
      messageLabel: '提交信息',
      messagePlaceholder: '填写本次上传的提交信息',
      generate: '生成提交信息',
      generating: '正在生成…',
      generateNote: '按已暂存改动生成 Conventional Commit 文案；生成是只读的，不会提交。',
      generateReplace: '输入框已有内容，用生成的提交信息替换吗？',
      generateNoResult: '生成没有返回结果，请手动填写。',
      /** 兜底文案（{reason} 由调用方按语言加括号，为空串时整体不出现）。 */
      generateFallback: '模型不可用，已填入确定性兜底文案{reason}；可直接改写后提交。',
      /** 兜底原因的外层括号（中文用全角）。 */
      generateFallbackReason: '（{reason}）',
      generateTruncated: '改动较多，生成时 diff 已截断；建议核对后再提交。',
      generateOk: '已根据已暂存改动生成，可直接改写。',
      generateFailed: '生成失败：{message}',
      preflightAndConfirm: '预检并准备确认',
      confirmTitle: '二次确认',
      confirmNote: '上传会把本地代码送出本机。请核对下面每一项，必要时返回修改。',
      confirmButton: '确认上传',
      cancel: '取消',
      uploading: '正在提交并上传…（commit → push）',
      successTitle: '上传成功',
      shaLabel: '提交 sha',
      copySha: '复制提交 sha',
      remoteNotAuto: '远端地址不在此处自动打开；如需查看，请自行复制到浏览器。',
      done: '完成',
      failedTitle: '上传失败（{code}）',
      back: '返回',
      incomplete: '上传结果不完整，请重试。',
      step1: '1 · 选择远端',
      step2: '2 · 认证状态',
      step3: '3 · 预检',
      step4: '4 · 范围与提交信息',
      remoteLabel: '远端',
      noRemote: '仓库没有配置远端。请先在仓库中添加远端后再上传。',
      authStatusLabel: '认证状态',
      noCredentialNote: '此远端尚未配置凭据。可使用系统 SSH 凭据，或粘贴访问令牌（令牌只写不读回，提交后立即清空）。',
      tokenLabel: '访问令牌',
      tokenPlaceholder: '粘贴访问令牌',
      saveToken: '保存并验证',
      disconnect: '断开连接',
      useSshAgent: '使用 SSH 凭据',
      noCredentialBridge: '主进程尚未提供凭据通道，令牌不会被保存。请改用 SSH 凭据或等待凭据桥接上线。',
      preflightNote: '上传前必须重新预检：脏工作区、领先/落后、分叉、远端可写性、网络。',
      startPreflight: '开始预检',
      branchLabel: '分支',
      aheadBehindLabel: '领先/落后',
      onlineLabel: '联网',
      filesLabel: '文件数',
      linesLabel: '行数',
      scopeFieldLabel: '范围',
      confirmMessageLabel: '提交信息',
    },
    failure: {
      authRequiredTitle: '未配置凭据',
      authRequiredAction1: '去配置凭据',
      authRequiredAction2: '改用 SSH 凭据',
      authRejectedTitle: '凭据被远端拒绝',
      authRejectedAction1: '重新输入令牌',
      authRejectedAction2: '检查令牌权限范围',
      offlineTitle: '网络不可达',
      offlineAction: '检查网络后重试',
      divergedTitle: '远端有新提交（分叉）',
      divergedAction1: '先拉取再上传',
      divergedAction2: '上传到新分支',
      cancelAction: '取消',
      noChangeTitle: '提交或推送被拒绝（无改动 / 无 upstream / 钩子或远端策略）',
      noChangeAction1: '查看脱敏后的远端消息',
      noChangeAction2: '检查远端与分支设置',
      noChangeAction3: '返回重新选择范围',
      blockedTitle: '操作被安全边界拦截',
      blockedAction: '返回重新选择参数',
      incompleteTitle: '上传没有返回完整结果',
      incompleteAction: '重试一次；若持续失败，请检查 Host 日志',
      unknownTitle: '上传失败',
      unknownAction1: '重试',
      unknownAction2: '改范围',
      unknownAction3: '去配置凭据',
    },
    graph: {
      truncated: '窗口外的父提交以虚线表示，还有更多历史。',
      empty: '仓库还没有提交记录。',
      loadMore: '加载更多',
      rowAria: '提交 {sha}，{subject}',
    },
    footer: {
      openDetail: '本会话改动见会话详情 →',
      scopeNote: '工作区口径与会话口径互不相加。',
    },
  },
  shell: {
    tag: '本地命令',
    hint: '未发送给模型',
    ariaLabel: '本地命令（未发送给模型）',
    running: '执行中…（如需审批，请在上方审批卡中批准）',
    ok: '本地命令执行完成（退出码 0）',
    failed: '本地命令执行失败',
    failedWith: '本地命令执行失败：{reason}',
    failedExit: '本地命令执行失败（退出码 {code}）',
    timeout: '命令超时（60 s）已被终止',
    denied: '命令被权限规则拒绝',
    deniedWith: '命令被权限规则拒绝：{reason}',
    emptyOutput: '（没有输出）',
    truncated: '输出已截断（上限 256 KiB）',
    stderrSeparator: '--- stderr ---',
    deniedNote: '没有执行任何命令；如需执行，请调整命令或权限规则。',
    meta: '退出码 {code} · 耗时 {ms} ms',
  },

  detail: {
    sections: { overview: '概览', changes: '改动', artifacts: '产出', sources: '来源', context: '上下文', capabilities: '能力' },
    changeStatus: { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' },
    artifactKind: { file: '文件', image: '图片', patch: '补丁', report: '报告', archive: '归档' },
    emptyChanges: '本会话没有文件改动',
    emptyArtifacts: '本会话没有产出文件',
    emptySources: '本会话没有参考来源',
    unknownStatus: '未知状态',
    unavailableStat: '不可统计',
    changeSummaryZero: '改动 0 个文件',
    changeSummary: '改动 {files} 个文件 · +{added} -{removed}',
    changeSummaryIncomplete: '改动 {files} 个文件 · 统计不完整',
    changeLineAria: '{path}，新增 {added} 行，删除 {removed} 行',
    changeLineAriaUnknown: '{path}，不可统计行数',
    changeLineExpanded: '，已展开只读 diff',
    changeLineCollapsed: '，点击查看只读 diff',
    actionPreview: '预览',
    actionCopyPath: '复制路径',
    actionReveal: '在文件管理器中显示',
    previewCollapse: '收起预览',
    copiedPath: '已复制路径',
    copyFailed: '复制失败，请手动选择路径',
    previewFailed: '预览失败',
    previewFailedWith: '预览失败：{message}',
    revealFailed: '无法在文件管理器中显示',
    revealFailedWith: '无法在文件管理器中显示：{message}',
    revealTitle: '在文件管理器中显示该文件',
    revealUnavailableTitle: '主进程未提供显示文件的通道',
    reading: '正在读取…',
    previewBinary: '二进制/图片文件，无法预览文本',
    previewTooLarge: '文件过大，无法在这里预览；完整内容请用外部编辑器打开',
    previewMissing: '文件已不存在（可能已被删除或移动）',
    previewEmpty: '文件是空的（0 字节），没有可预览的内容',
    previewTruncated: '文件过大，只显示前一部分；完整内容请用外部编辑器打开',
    trustVerified: '已验证',
    trustDeclared: '未验证（来源声明）',
    trustUnverified: '未验证',
    sourceCount: '出现 {count} 次',
    sourceLineAria: '{name}，域名 {domain}，{count}，{trust}',
    diffBinary: '二进制文件，无法显示文本 diff',
    diffTooLarge: '差异过大，只显示行数',
    diffNoSnapshot: '本次会话没有留下改动前的内容（例如应用重启后），无法对比',
    diffDeleted: '文件已删除，显示删除前的行数',
    diffNoText: '本次会话没有产生文本差异（或只有权限/模式变化）',
    diffTruncatedNote: '差异过长，下面只显示前一部分',
    diffNotRecorded: '本会话没有记录过这个路径的改动，无法生成 diff',
    diffReadFailed: '读取 diff 失败',
    diffReadFailedWith: '读取 diff 失败：{message}',
    diffRuntimeEmpty: '运行时没有返回该文件的 diff',
    previewRuntimeEmpty: '运行时没有返回预览内容',
    coverageFallback: '命令改动未逐文件统计',
    overviewTurns: '轮次',
    overviewRequests: '请求',
    overviewCost: '估算成本',
    overviewCacheRead: '缓存读取',
    overviewTotalTokens: '总 tokens',
    overviewDuration: '请求耗时',
    overviewInput: '输入',
    overviewOutput: '输出',
    overviewErrors: '错误请求',
    overviewNoSession: '未选择会话',
    overviewCostNote: '成本按当前渠道单价估算，非账单。',
    overviewWorkspace: '工作区',
    overviewModel: '模型',
    overviewPermission: '权限',
    overviewUsageNote: '用量来自本地记录，按天汇总。',
    contextEstimated: '估算占用',
    contextSegmentFallback1: '系统提示',
    contextSegmentFallback2: '工具定义',
    contextSegmentFallback3: '对话历史',
    contextNote: '最近请求的文本估算，非精确 tokenizer 计数。',
    contextCapacityConfigured: '用户配置',
    contextRemaining: '剩余 {tokens} tokens',
    contextNoCompaction: '未启用自动压缩',
    capabilitiesSubtitle: '本会话可用能力',
    capabilityAvailable: '可用',
    capabilityUnavailable: '未接入',
    capabilityOpenHelp: '查看能力说明 →',
    capabilitiesNotLoaded: '尚未读取能力清单。',
    permissionNames: { plan: '只读规划', strict: '严格审批', default: '标准权限', acceptEdits: '自动编辑', bypass: '完全授权' },
    closeAria: '关闭',
    title: '会话',
    changesScopeNote: '会话口径：只统计本会话的工具改动，与 Git 侧栏的"工作区未提交改动"互不相加。',
    diffAria: '{path} 的会话口径只读 diff',
    sectionAria: '{title}分区',
    sourceTool: '来源工具',
    artifactsCount: '{count} 项产出',
    sourcesCount: '{count} 条来源',
    artifactsNone: '暂无产出',
    sourcesNone: '暂无来源',
    changeDiffReading: '正在读取会话 diff…',
    changeDiffNoResult: '没有取到该文件的 diff。',
    contextNotCollected: '尚未采集',
    contextCapacityAdapter: '适配器默认',
    contextCapacityFallback: '未知来源',
    unknownCostNote: '{count} 次请求未提供定价，成本仅为已知部分。',
    usageTotalsNote: '累计用量不等于当前上下文或上游账单。',
    artifactSizeLabel: '大小',
    artifactToolLabel: '来源工具',
    artifactLineAria: '{name}，{kind}，{size}，来源工具 {tool}',
  },
  relative: {
    justNow: '刚刚',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    daysAgo: '{n} 天前',
  },
  palette: {
    title: '命令面板',
    commandListLabel: '命令面板',
    fileListLabel: '文件引用',
    noFiles: '未取到工作区文件（可在会话详情查看）',
    noCommand: '没有匹配的命令',
    noFileMatch: '没有匹配的文件',
    loadingFiles: '正在读取工作区文件…',
    hint: '输入 @ 引用工作区文件',
    keysCommand: '↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭',
    keysFile: '↑↓ 选择 · Enter 引用 · Esc 关闭',
    groupCommand: '命令',
    groupFile: '文件引用',
    fileHint: '引用工作区文件',
    helpText: '可用命令：/new 新建会话 · /model 选择模型 · /permission 切换权限 · /stop 停止运行 · /archive 归档会话 · /git Git 侧栏 · /detail 会话详情 · /usage 用量统计 · /help 帮助。输入 @ 引用工作区文件；Enter 发送，Shift Enter 换行。',
    shellHint: '! 直接在本机会话工作区执行命令（结果不回传给模型）；仍过权限闸门：危险命令会被拒绝，写类命令会先请你批准。',
    commands: {
      new: { title: '新建会话', hint: '在当前项目创建新会话' },
      model: { title: '选择模型', hint: '打开渠道与模型选择器' },
      permission: { title: '切换权限', hint: '聚焦会话权限下拉框' },
      stop: { title: '停止运行', hint: '停止当前轮次（运行中可用）' },
      archive: { title: '归档会话', hint: '归档当前会话，可在会话树恢复' },
      git: { title: '打开 Git 侧栏', hint: '切换到右栏 Git 槽位' },
      detail: { title: '会话详情', hint: '切换到右栏会话详情' },
      usage: { title: '用量统计', hint: '打开用量页' },
      help: { title: '帮助', hint: '在输入区插入命令与快捷键帮助（不发送）' },
    },
  },
};

const en: DesktopMessages = {
  git: {
    tabs: {
      changes: 'Changes',
      graph: 'Commit graph',
      branches: 'Branches',
      upload: 'Upload',
    },
    panel: {
      ariaLabel: 'Git sidebar',
      tabsLabel: 'Git panel',
      refreshAria: 'Refresh Git status',
      refreshTitle: 'Refresh',
      closeAria: 'Close the Git sidebar',
      closeTitle: 'Close',
    },
    header: {
      detachedBadge: 'Detached',
      detachedHead: 'Detached HEAD',
      branchNotLoaded: 'Not loaded yet',
      onlineSr: 'Network status: {label}',
      authSr: 'Auth status: {label}',
    },
    status: {
      added: 'Added',
      modified: 'Modified',
      deleted: 'Deleted',
      renamed: 'Renamed',
      untracked: 'Untracked',
      conflicted: 'Conflicted',
      unknown: 'Unknown status',
    },
    group: {
      staged: 'Staged',
      unstaged: 'Not staged',
      untracked: 'Untracked',
      empty: 'None',
    },
    file: {
      statUnavailable: 'Not measurable',
      whereStaged: 'staged',
      whereUnstaged: 'not staged',
      whereUntracked: 'untracked',
      ariaUnavailable: '{path}, {status}, {where}, line counts are not measurable',
      ariaChanged: '{path}, {status}, {where}, {added} lines added, {removed} lines removed',
      stageAction: 'Stage',
      unstageAction: 'Unstage',
      stageAria: '{action} {path}',
    },
    summary: {
      notLoaded: 'Uncommitted working-tree changes · not loaded yet',
      empty: 'Uncommitted working-tree changes · 0 files',
      incomplete: 'Uncommitted working-tree changes · {files} files · counts are incomplete',
      withCounts: 'Uncommitted working-tree changes · {files} files · +{added} -{removed}',
      badgeFiles: '{files} files',
    },
    scope: {
      staged: 'Working-tree scope: what the index will commit (staged differences).',
      worktree: 'Working-tree scope: differences against the index (untracked files are compared as they are on disk).',
    },
    diff: {
      binary: 'Binary file, no text diff can be shown',
      binaryBadge: 'Binary file',
      truncated: 'The diff is too long, only the first part is shown',
      noText: 'This file has no text differences in the current scope',
      aria: 'Read-only diff of {path}',
      openAria: 'Show the read-only diff of {path}',
      collapseAria: 'Hide the read-only diff of {path}',
      readFailed: 'Could not read the diff: {message}',
      readingAria: 'Loading the read-only diff',
      reading: 'Loading',
      unavailable: 'Unavailable',
      readingBody: 'Loading the working-tree diff of this file…',
      unavailableBody: 'The working-tree diff of this file could not be read (it may have been deleted or moved)',
    },
    changes: {
      truncated: 'The output was truncated, so the file list is incomplete.',
      empty: 'The working tree has no uncommitted changes.',
      notLoaded: 'Workspace status has not been read yet.',
    },
    hooks: {
      notLoaded: 'Hook status has not been loaded yet',
      none: 'There are no executable commit hooks',
      willRun: '{count} hook(s) will run ({names})',
      inactive: 'Present but not executable (Git will not run them): {names}',
    },
    commit: {
      aria: 'Commit the staged changes',
      label: 'Commit message',
      placeholder: 'Write the commit message',
      submit: 'Commit staged changes',
      submitting: 'Committing…',
      unknownSize: 'Unknown size',
      skipHooks: 'Skip hooks (--no-verify, it is recorded in the audit log)',
      allowEmpty: 'Allow an empty commit (--allow-empty)',
      emptyHint: 'Empty commits are rejected by default: with nothing staged you must tick “Allow an empty commit” to commit.',
      largeFiles: 'These staged files are larger than {size}:',
      largeFilesNote: 'This is only a warning, it does not block the commit.',
      localNote: 'Committing is a local write: stage first, then commit; force pushing is not offered.',
      done: 'The commit finished.',
      unsignedDone: 'This commit is not signed (recorded in the audit log).',
      failed: 'The commit failed: {message}',
    },
    signing: {
      title: 'The commit could not be signed',
      hint: 'A signing failure is never downgraded silently. Pick one path:',
      retry: 'Retry',
      retryHint: 'Submit again with the same parameters; nothing is retried automatically.',
      unsigned: 'Commit without signing',
      unsignedHint: 'This commit is not signed (--no-gpg-sign); it is recorded in the audit log.',
      cancel: 'Cancel',
      cancelHint: 'Nothing is committed and the message you wrote is kept.',
      cancelNote: 'Cancelling keeps the commit message and runs no commit at all.',
    },
    ahead: {
      unknown: 'Ahead/behind unknown',
      value: 'Ahead {ahead} · behind {behind}',
    },
    unknownWord: {
      unknown: 'unknown',
    },
    auth: {
      unknown: 'Auth status unknown',
      notConfigured: 'No credentials configured',
      configuredNotVerified: 'Credentials are configured but not verified yet',
      ready: 'Auth ready · {method}{account}',
      account: ' ({account})',
      methodOauth: 'Browser authorization',
      methodSshAgent: 'System SSH credentials',
      methodSshKey: 'SSH key',
      methodToken: 'Access token',
      methodNone: 'No credentials',
    },
    oauth: {
      hintReady: 'Press start and finish the authorization in the browser; no client_id is needed.',
      hintClientId: 'You have to enter your own OAuth App client_id (the open-source build ships none). The client_id only lives in this page and is never written to disk.',
      hintUnsupported: 'This provider does not support the device-code flow; use SSH credentials or an access token instead.',
      pending: 'Waiting for the browser authorization…',
      slowDown: 'The authorization server asked us to slow down; the check interval was increased and we keep waiting…',
      ready: 'Authorization succeeded',
      denied: 'You denied the authorization in the browser',
      expired: 'The device code has expired',
      failureDenied: 'You denied the authorization in the browser; start the flow again to retry.',
      failureExpired: 'The device code has expired; start again (an expired code cannot be reused).',
      alreadyExpired: 'Already expired',
      remainingSeconds: '{seconds} seconds left',
      remainingMinutes: '{minutes} min {seconds} s left',
      errorUnavailable: 'Browser authorization is not available for this provider: the open-source build ships no client_id, so enter your own OAuth App client_id or use SSH / an access token.',
      errorPending: 'The authorization is still in progress; try again in a moment.',
      errorFailed: 'Browser authorization failed',
      errorFailedWith: 'Browser authorization failed: {message}',
      providersLabel: 'Authorization provider',
      clientIdLabel: 'OAuth App client_id',
      clientIdPlaceholder: 'Enter your own OAuth App client_id',
      clientIdNote: 'The client_id only lives in this page and is cleared on reload; it is never written to disk and never sent anywhere except the authorization server.',
      start: 'Start browser authorization',
      openButton: 'Open in the browser',
      starting: 'Requesting a device code…',
      copyCode: 'Copy the device code',
      openTitle: 'Open the authorization page in the system browser',
      openUnavailableTitle: 'The host does not offer a way to open external links',
      openNote: 'You have to check the authorization URL and the device code yourself; this app never opens a browser on its own and never fills the code in for you.',
      openUnavailableNote: 'The host does not offer a way to open external links: copy the authorization URL above and open it in your browser.',
      waitingFirst: 'Waiting for the first check…',
      pollStatus: '{status} (check #{count})',
      success: 'Authorization succeeded{account}; the auth status was reloaded.',
      successAccount: ' (account {account})',
      notCompleted: 'The authorization did not complete; see the error below.',
      remaining: '{remaining} (at most {limit} checks)',
      cancel: 'Cancel the authorization',
      restart: 'Start over',
      deviceCode: 'Device code',
      verificationUri: 'Authorization URL',
      title: 'Browser authorization (device code)',
      noPollApi: 'The runtime does not provide a polling method',
      pollLimit: 'Still not authorized after {limit} checks; polling stopped.',
      needClientId: 'Enter your own OAuth App client_id first.',
    },
    online: {
      unknown: 'Unknown (run “Start preflight” to check the connection)',
      unknownShort: 'Unknown',
      online: 'Online',
      offline: 'Offline',
    },
    branch: {
      remote: 'Remote {name}',
      current: ' (current)',
      currentBadge: 'Current',
      localGroup: 'Local branches',
      remoteGroup: 'Remote branches',
      upstream: 'Upstream {name}',
      switch: 'Switch',
      newLabel: 'New branch',
      newPlaceholder: 'Branch name',
      create: 'Create branch',
      detachedNote: 'The HEAD is detached; commit or keep your changes before switching branches.',
    },
    upload: {
      scopeAll: 'All uncommitted changes',
      scopeSession: 'Only this session’s changes',
      scopeLabel: 'Upload scope',
      messageLabel: 'Commit message',
      messagePlaceholder: 'Write the commit message for this upload',
      generate: 'Generate the commit message',
      generating: 'Generating…',
      generateNote: 'Generates a Conventional Commit message from the staged changes; generating is read-only and never commits.',
      generateReplace: 'The field already has content; replace it with the generated commit message?',
      generateNoResult: 'Generation returned nothing; please write the message yourself.',
      /** 兜底文案（{reason} 由调用方按语言加括号，为空串时整体不出现）。 */
      generateFallback: 'The model was unavailable, so a deterministic fallback message was filled in{reason}; you can edit it before committing.',
      /** 兜底原因的外层括号（英文用半角）。 */
      generateFallbackReason: ' ({reason})',
      generateTruncated: 'There are many changes, so the diff was truncated while generating; please review it before committing.',
      generateOk: 'Generated from the staged changes; you can still edit it.',
      generateFailed: 'Generation failed: {message}',
      preflightAndConfirm: 'Preflight and prepare the confirmation',
      confirmTitle: 'Confirmation',
      confirmNote: 'Uploading sends your local code out of this machine. Check every item below and go back if something is wrong.',
      confirmButton: 'Confirm upload',
      cancel: 'Cancel',
      uploading: 'Committing and uploading… (commit → push)',
      successTitle: 'Upload succeeded',
      shaLabel: 'Commit sha',
      copySha: 'Copy the commit sha',
      remoteNotAuto: 'The remote URL is not opened automatically; copy it into a browser if you want to look.',
      done: 'Done',
      failedTitle: 'Upload failed ({code})',
      back: 'Back',
      incomplete: 'The upload result was incomplete; please retry.',
      step1: '1 · Choose a remote',
      step2: '2 · Auth status',
      step3: '3 · Preflight',
      step4: '4 · Scope and commit message',
      remoteLabel: 'Remote',
      noRemote: 'The repository has no remote. Add one before uploading.',
      authStatusLabel: 'Auth status',
      noCredentialNote: 'This remote has no credentials yet. Use the system SSH credentials or paste an access token (tokens are write-only and are cleared right after they are submitted).',
      tokenLabel: 'Access token',
      tokenPlaceholder: 'Paste an access token',
      saveToken: 'Save and verify',
      disconnect: 'Disconnect',
      useSshAgent: 'Use SSH credentials',
      noCredentialBridge: 'The host does not offer a credential channel yet, so the token will not be stored. Use SSH credentials or wait for the credential bridge.',
      preflightNote: 'The preflight must be rerun before uploading: dirty working tree, ahead/behind, divergence, remote writability and network.',
      startPreflight: 'Start preflight',
      branchLabel: 'Branch',
      aheadBehindLabel: 'Ahead/behind',
      onlineLabel: 'Network',
      filesLabel: 'Files',
      linesLabel: 'Lines',
      scopeFieldLabel: 'Scope',
      confirmMessageLabel: 'Commit message',
    },
    failure: {
      authRequiredTitle: 'No credentials configured',
      authRequiredAction1: 'Configure credentials',
      authRequiredAction2: 'Use SSH credentials instead',
      authRejectedTitle: 'The remote rejected the credentials',
      authRejectedAction1: 'Enter the token again',
      authRejectedAction2: 'Check the token scopes',
      offlineTitle: 'The network is unreachable',
      offlineAction: 'Check the network and retry',
      divergedTitle: 'The remote has new commits (diverged)',
      divergedAction1: 'Pull first, then upload',
      divergedAction2: 'Upload to a new branch',
      cancelAction: 'Cancel',
      noChangeTitle: 'The commit or push was rejected (nothing to commit / no upstream / a hook or a remote policy)',
      noChangeAction1: 'Read the redacted remote message',
      noChangeAction2: 'Check the remote and branch settings',
      noChangeAction3: 'Go back and choose the scope again',
      blockedTitle: 'The operation was blocked by a safety boundary',
      blockedAction: 'Go back and choose the parameters again',
      incompleteTitle: 'The upload did not return a complete result',
      incompleteAction: 'Retry; if it keeps failing, check the host logs',
      unknownTitle: 'The upload failed',
      unknownAction1: 'Retry',
      unknownAction2: 'Change the scope',
      unknownAction3: 'Configure credentials',
    },
    graph: {
      truncated: 'Parents outside the window are drawn dashed; there is more history.',
      empty: 'The repository has no commits yet.',
      loadMore: 'Load more',
      rowAria: 'Commit {sha}, {subject}',
    },
    footer: {
      openDetail: 'This session’s changes are in the session detail →',
      scopeNote: 'The working-tree scope and the session scope are never added together.',
    },
  },
  shell: {
    tag: 'Local command',
    hint: 'Not sent to the model',
    ariaLabel: 'Local command (not sent to the model)',
    running: 'Running… (if approval is needed, approve it in the card above)',
    ok: 'Local command finished (exit code 0)',
    failed: 'Local command failed',
    failedWith: 'Local command failed: {reason}',
    failedExit: 'Local command failed (exit code {code})',
    timeout: 'Command timed out after 60s and was terminated',
    denied: 'The command was denied by the permission rules',
    deniedWith: 'The command was denied by the permission rules: {reason}',
    emptyOutput: '(no output)',
    truncated: 'Output was truncated (limit 256 KiB)',
    stderrSeparator: '--- stderr ---',
    deniedNote: 'No command was run. Adjust the command or the permission rules to proceed.',
    meta: 'exit code {code} · {ms} ms',
  },

  detail: {
    sections: { overview: 'Overview', changes: 'Changes', artifacts: 'Artifacts', sources: 'Sources', context: 'Context', capabilities: 'Capabilities' },
    changeStatus: { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' },
    artifactKind: { file: 'File', image: 'Image', patch: 'Patch', report: 'Report', archive: 'Archive' },
    emptyChanges: 'This session has no file changes',
    emptyArtifacts: 'This session has no artifacts',
    emptySources: 'This session has no reference sources',
    unknownStatus: 'Unknown status',
    unavailableStat: 'not countable',
    changeSummaryZero: '0 files changed',
    changeSummary: '{files} file(s) changed · +{added} -{removed}',
    changeSummaryIncomplete: '{files} file(s) changed · line counts unavailable ({unavailable} file(s))',
    changeLineAria: '{path}, {status}, {added} line(s) added, {removed} removed',
    changeLineAriaUnknown: '{path}, {status}, line counts unavailable',
    changeLineExpanded: ', read-only diff expanded',
    changeLineCollapsed: ', click to view the read-only diff',
    actionPreview: 'Preview',
    actionCopyPath: 'Copy path',
    actionReveal: 'Show in file manager',
    previewCollapse: 'Collapse preview',
    copiedPath: 'Path copied',
    copyFailed: 'Copy failed; select the path manually',
    previewFailed: 'Preview failed',
    previewFailedWith: 'Preview failed: {message}',
    revealFailed: 'Could not show the file in the file manager',
    revealFailedWith: 'Could not show the file in the file manager: {message}',
    revealTitle: 'Show this file in the file manager',
    revealUnavailableTitle: 'The main process does not expose a reveal channel',
    reading: 'Loading…',
    previewBinary: 'Binary or image file; text can not be previewed',
    previewTooLarge: 'The file is too large to preview here; open it in an external editor',
    previewMissing: 'The file no longer exists (it may have been deleted or moved)',
    previewEmpty: 'The file is empty (0 bytes), so there is nothing to preview',
    previewTruncated: 'The file is too large; only the beginning is shown. Open it in an external editor for the full content',
    trustVerified: 'Verified',
    trustDeclared: 'Unverified (declared by the source)',
    trustUnverified: 'Unverified',
    sourceCount: 'seen {count} time(s)',
    sourceLineAria: '{name}, {kind}, {trust}',
    diffBinary: 'Binary file; no textual diff can be shown',
    diffTooLarge: 'The diff is too large; only line counts are shown',
    diffNoSnapshot: 'This session kept no pre-change content (for example after an app restart), so there is nothing to compare',
    diffDeleted: 'The file was deleted; the line count before deletion is shown',
    diffNoText: 'This session produced no textual difference (or only permission/mode changes)',
    diffTruncatedNote: 'The diff is long; only the first part is shown below',
    diffNotRecorded: 'This session recorded no change for this path, so no diff can be produced',
    diffReadFailed: 'Could not read the diff',
    diffReadFailedWith: 'Could not read the diff: {message}',
    diffRuntimeEmpty: 'The runtime returned no diff for this file',
    previewRuntimeEmpty: 'The runtime returned no preview content',
    coverageFallback: 'Command changes were not counted per file',
    overviewTurns: 'Turns',
    overviewRequests: 'Requests',
    overviewCost: 'Estimated cost',
    overviewCacheRead: 'Cache reads',
    overviewTotalTokens: 'Total tokens',
    overviewDuration: 'Request time',
    overviewInput: 'Input',
    overviewOutput: 'Output',
    overviewErrors: 'Failed requests',
    overviewNoSession: 'No session selected',
    overviewCostNote: 'Cost is estimated from the current channel pricing, not a bill.',
    overviewWorkspace: 'Workspace',
    overviewModel: 'Model',
    overviewPermission: 'Permissions',
    overviewUsageNote: 'Usage comes from local records, aggregated by day.',
    contextEstimated: 'estimated usage',
    contextSegmentFallback1: 'System prompt',
    contextSegmentFallback2: 'Tool definitions',
    contextSegmentFallback3: 'Conversation history',
    contextNote: 'A text estimate of the most recent request, not an exact tokenizer count.',
    contextCapacityConfigured: 'user configured',
    contextRemaining: '{tokens} tokens remaining',
    contextNoCompaction: 'Automatic compaction is off',
    capabilitiesSubtitle: 'Capabilities available in this session',
    capabilityAvailable: 'Available',
    capabilityUnavailable: 'Not connected',
    capabilityOpenHelp: 'See what this capability does →',
    capabilitiesNotLoaded: 'The capability list has not been read yet.',
    permissionNames: { plan: 'Read-only planning', strict: 'Strict approval', default: 'Standard permissions', acceptEdits: 'Auto-edit', bypass: 'Full authorization' },
    closeAria: 'Close',
    title: 'Session',
    changesScopeNote: 'Session scope: only this session\'s tool changes are counted; they are never added to the Git sidebar\'s uncommitted working-tree changes.',
    diffAria: 'Read-only session-scope diff of {path}',
    sectionAria: '{title} section',
    sourceTool: 'Source tool',
    artifactsCount: '{count} artifact(s)',
    sourcesCount: '{count} source(s)',
    artifactsNone: 'No artifacts yet',
    sourcesNone: 'No sources yet',
    changeDiffReading: 'Reading the session diff…',
    changeDiffNoResult: 'No diff was returned for this file.',
    contextNotCollected: 'not collected yet',
    contextCapacityAdapter: 'adapter default',
    contextCapacityFallback: 'unknown source',
    unknownCostNote: '{count} request(s) reported no pricing, so the cost covers only the known part.',
    usageTotalsNote: 'Cumulative usage is not the current context, nor an upstream bill.',
    artifactSizeLabel: 'Size',
    artifactToolLabel: 'Source tool',
    artifactLineAria: '{name}, {kind}, {size}, source tool {tool}',
  },
  relative: {
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',
    daysAgo: '{n} d ago',
  },
  palette: {
    title: 'Command palette',
    commandListLabel: 'Command palette',
    fileListLabel: 'File reference',
    noFiles: 'No workspace files found (they are listed in the session detail panel)',
    noCommand: 'No matching command',
    noFileMatch: 'No matching file',
    loadingFiles: 'Reading workspace files…',
    hint: 'Type @ to reference a workspace file',
    keysCommand: '↑↓ to move · Enter to run · Tab to complete · Esc to close',
    keysFile: '↑↓ to move · Enter to reference · Esc to close',
    groupCommand: 'Commands',
    groupFile: 'Files',
    fileHint: 'Reference a workspace file',
    helpText: 'Commands: /new new session · /model choose a model · /permission change permissions · /stop stop the run · /archive archive the session · /git Git sidebar · /detail session detail · /usage usage · /help help. Type @ to reference a workspace file; Enter sends, Shift+Enter adds a newline.',
    shellHint: '! runs the command directly in this session\'s workspace (the result is not sent to the model). It still goes through the permission gate: dangerous commands are refused, and commands that write will ask you first.',
    commands: {
      new: { title: 'New session', hint: 'Create a new session in this project' },
      model: { title: 'Choose a model', hint: 'Open the channel and model picker' },
      permission: { title: 'Change permissions', hint: 'Focus the session permission selector' },
      stop: { title: 'Stop the run', hint: 'Stop the current turn (available while running)' },
      archive: { title: 'Archive session', hint: 'Archive this session; it can be restored from the session tree' },
      git: { title: 'Open Git sidebar', hint: 'Switch the right rail to the Git slot' },
      detail: { title: 'Session detail', hint: 'Switch the right rail to the session detail' },
      usage: { title: 'Usage', hint: 'Open the usage page' },
      help: { title: 'Help', hint: 'Insert the command and shortcut help (does not send)' },
    },
  },
};

const BUNDLES: Readonly<Record<Lang, DesktopMessages>> = { zh, en };

/** 取桌面端文案目录。 */
export function desktopMessages(lang: Lang): DesktopMessages {
  return BUNDLES[lang];
}

/**
 * 按 `a.b.c` 路径取值并做 `{name}` 插值。
 *
 * 未知路径返回 `⟦path⟧` —— 缺失必须**看得见**。空串会让"漏翻译"看起来像"设计如此"。
 */
export function t(lang: Lang, path: string, vars: Readonly<Record<string, string | number>> = {}): string {
  const found = path.split('.').reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
    BUNDLES[lang] as unknown,
  );
  if (typeof found !== 'string') return `⟦${path}⟧`;
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

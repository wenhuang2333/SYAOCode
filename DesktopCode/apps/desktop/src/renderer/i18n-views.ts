/**
 * 桌面端"页面级"文案目录（`27` FR-N-037）。
 *
 * 为什么和 `i18n.ts` 分开：`i18n.ts` 已经装着 shell / palette / relative / git / detail，
 * 三个页面（工作台 / 设置 / 用量）的文案量大且自成一体，单独一个文件更易审阅；
 * 语义与 `t()` **完全一致**：中英键集相同、无空串、未知键返回 `⟦path⟧`、`{name}` 插值。
 *
 * 纪律（由 `test/i18n-views.test.ts` 守着）：
 *  1. 中英键集完全相同；
 *  2. 没有空串（空串会把"漏翻译"伪装成"设计如此"）；
 *  3. 未知键显式可见，不静默回退；
 *  4. 插值缺参数时保留 `{name}` 原样，不出现 `undefined`。
 */

import type { Lang } from './i18n';

/** 页面文件只从本模块取 `Lang`，避免每个调用点都再引一次 `i18n.ts`。 */
export type { Lang };

export interface ViewsMessages {
  /**
   * 宿主侧错误提示（`use-workbench.ts`）。
   *
   * 单独成组：这些是**运行期错误**，会直接出现在顶部红色横幅里。
   * 它们此前是硬编码中文——用户切到英文后，界面整体是英文，
   * 唯独出错的横幅还是中文。半翻译的界面比全中文更难判断发生了什么。
   */
  readonly errors: {
    readonly operationIncomplete: string;
    readonly runtimeNotConnected: string;
    readonly desktopBridgeMissing: string;
    readonly runtimeExited: string;
    readonly noSession: string;
    readonly noWorkspace: string;
    readonly actionInFlight: string;
    readonly uploadIncomplete: string;
    readonly noCredentialChannel: string;
    readonly noCredentialChannelPlain: string;
    readonly noSshCredentialChannel: string;
    readonly noProject: string;
    readonly sessionBusy: string;
    readonly newSessionTitle: string;
  };

  readonly workbench: {
    readonly nav: {
      /** 工作台 */
      readonly chat: string;
      /** 用量统计 */
      readonly usage: string;
      /** 会话树 */
      readonly sessions: string;
      /** 变更与文件 */
      readonly files: string;
      /** Agent 群 */
      readonly agents: string;
      /** MCP 服务 */
      readonly resources: string;
      /** 渠道与设置 */
      readonly settings: string;
    };
    readonly caption: {
      /** 监控 */
      readonly monitor: string;
      /** 会话 */
      readonly sessions: string;
      /** 资源 */
      readonly resources: string;
    };
    readonly brand: {
      /** DESKTOP · 本地工作台 */
      readonly subtitle: string;
    };
    readonly sidebar: {
      /** 主导航 */
      readonly mainNav: string;
      /** 新建会话 */
      readonly newSession: string;
      /** 搜索会话 */
      readonly searchAria: string;
      /** 搜索会话与项目 */
      readonly searchPlaceholder: string;
      /** 清空搜索 */
      readonly clearSearch: string;
      /** 项目 */
      readonly projects: string;
      /** 添加项目 */
      readonly addProject: string;
      /** 添加项目目录 */
      readonly addProjectTitle: string;
      /** 我的项目 */
      readonly myProjects: string;
      /** {count} 会话 */
      readonly sessionCount: string;
      /** 展开 {name} */
      readonly expand: string;
      /** 收起 {name} */
      readonly collapse: string;
      /** 没有匹配的会话 */
      readonly noMatchingSessions: string;
      /** 尚无会话 */
      readonly noSessions: string;
      /** 未找到匹配的会话 */
      readonly noMatchingAtAll: string;
      /** 运行时未连接 */
      readonly runtimeNotConnected: string;
      /** 正在载入项目… */
      readonly loadingProjects: string;
      /** 余额与配额 */
      readonly accountSummary: string;
      /** 今日 {tokens} tokens */
      readonly todayTokens: string;
      /** 离线演示 */
      readonly offlineDemo: string;
      /** 余额未提供 */
      readonly balanceUnknown: string;
      /** 手动记录 · {date} */
      readonly manualRecord: string;
      /** 凭据就绪 · 配额未提供 */
      readonly credentialReadyQuotaUnknown: string;
      /** 未配置凭据 · 点击设置 */
      readonly credentialNotConfigured: string;
      /** 本地工作空间 */
      readonly localWorkspace: string;
      /** 运行时已连接 */
      readonly statusConnected: string;
      /** 连接失败 */
      readonly statusFailed: string;
      /** 正在重新连接 */
      readonly statusReconnecting: string;
      /** 正在启动 */
      readonly statusBooting: string;
      /** 运行中 */
      readonly running: string;
      /** 渠道与设置 */
      readonly channelsAndSettings: string;
    };
    readonly picker: {
      /** 选择渠道与模型 */
      readonly aria: string;
      /** 渠道 */
      readonly channelColumn: string;
      /** 模型 · {name} */
      readonly modelsOf: string;
      /** 管理渠道与凭据 → */
      readonly manageChannels: string;
      /** 思考等级 */
      readonly reasoningLabel: string;
      /** 模型默认 */
      readonly modelDefault: string;
      /** 当前 Agent 适配器未接入思考预算控制，不发送无效参数。 */
      readonly reasoningNote: string;
      /** 离线演示 */
      readonly offlineDemo: string;
      /** 尚无模型，请在设置中添加真实模型 ID。 */
      readonly noModels: string;
      /** 请先配置渠道凭据 */
      readonly needCredential: string;
      /**  · {tokens} 上下文 */
      readonly contextWindow: string;
      /** 选择渠道与模型 */
      readonly choosePlaceholder: string;
    };
    readonly welcome: {
      /** 正在打开会话 */
      readonly openingSession: string;
      /** YOUR LOCAL CODING WORKSPACE */
      readonly eyebrow: string;
      /** 从一个想法，开始构建。 */
      readonly title: string;
      /** 理解代码、规划方案、执行任务。 */
      readonly body: string;
      /** 每个项目的上下文与会话，都在这里井然有序。 */
      readonly bodySecond: string;
      /** 先选择一个项目 */
      readonly chooseProject: string;
      /** 切换目录 */
      readonly switchDirectory: string;
      /** 在此项目新建会话 */
      readonly createSession: string;
      /** 理解项目 */
      readonly starterUnderstand: string;
      /** 请先阅读当前项目，梳理目录结构与主要模块，不要修改代码。 */
      readonly starterUnderstandPrompt: string;
      /** 规划改动 */
      readonly starterPlan: string;
      /** 请先分析项目现状，帮我制定分步骤的开发和验证计划。 */
      readonly starterPlanPrompt: string;
      /** 检查代码 */
      readonly starterReview: string;
      /** 请检查当前项目可能存在的问题，给出有文件依据的改进建议。 */
      readonly starterReviewPrompt: string;
      /** 从清晰的上下文开始 → */
      readonly starterHint: string;
      /** 本地会话自动保存 · 需要授权的工具操作会先询问你（仅在会询问的权限档位下） */
      noticeAsking: string;
      /** 本地会话自动保存 · 当前权限档位不逐次询问（仅在 acceptEdits / bypass 档位下） */
      noticeNotAsking: string;
      /** 本地会话自动保存 · 需要授权的工具操作会先询问你 */
      readonly notice: string;
    };
    readonly conversation: {
      /** 本地命令记录（未发送给模型） */
      readonly shellLines: string;
      /** 请在 ! 后输入要执行的命令。 */
      readonly shellEmpty: string;
      /** 上一条本地命令仍在执行，请稍候。 */
      readonly shellBusy: string;
      /** 当前无法聚焦权限选择（会话运行中或未连接）。 */
      readonly focusPermissionFailed: string;
      /** 当前没有正在运行的轮次。 */
      readonly noRunningTurn: string;
      /** 还没有可归档的会话。 */
      readonly noSessionToArchive: string;
      /** 会话权限 */
      readonly permissionAria: string;
      /** 停止运行 */
      readonly stopRunning: string;
      /** 离线演示模型 · 不会调用真实厂商 API */
      readonly mockFootnote: string;
      /** 模型输出仅供参考，工具执行由权限引擎控制 */
      readonly modelFootnote: string;
      /** Enter 发送 · Shift Enter 换行 */
      readonly enterHint: string;
    };
    readonly permission: {
      /** 只读规划 */
      readonly plan: string;
      /** 严格审批 */
      readonly strict: string;
      /** 标准权限 */
      readonly default: string;
      /** 自动编辑 */
      readonly acceptEdits: string;
      /** 完全授权 */
      readonly bypass: string;
    };
    readonly sessions: {
      /** 会话树 */
      readonly title: string;
      /** 按项目组织工作，随时回到未完成的思考。 */
      readonly subtitle: string;
      /** 新建会话 */
      readonly newSession: string;
      /** 进行中的会话 */
      readonly tabActive: string;
      /** 已归档 */
      readonly tabArchived: string;
      /** 没有匹配的会话 */
      readonly emptyNoMatch: string;
      /** 暂无归档会话 */
      readonly emptyArchived: string;
      /** 创建你的第一个会话 */
      readonly emptyFirst: string;
      /** 会话保存在本机，不会因为关闭窗口而消失。 */
      readonly emptyBody: string;
      /** 恢复会话 */
      readonly restore: string;
      /** 空闲 */
      readonly idle: string;
      /** 运行中 */
      readonly running: string;
      /** {count} 会话 */
      readonly count: string;
      /** {model} · {count} 轮 · {time} */
      readonly turns: string;
    };
    readonly files: {
      /** 变更与文件 */
      readonly title: string;
      /** 项目文件 */
      readonly tabFiles: string;
      /** 本会话工具记录 */
      readonly tabTools: string;
      /** 正在读取目录… */
      readonly readingTree: string;
      /** 目录为空或尚未添加项目 */
      readonly emptyTree: string;
      /** 文件预览 */
      readonly preview: string;
      /** 只读 */
      readonly readOnly: string;
      /** 正在读取… */
      readonly reading: string;
      /** 选择一个文件查看内容 */
      readonly pickFile: string;
      /** 敏感文件及工作区外路径不可读取 */
      readonly sensitiveNote: string;
      /** \n\n[文件已按读取上限截断] */
      readonly truncated: string;
      /** 这是本会话的真实工具执行记录，不代表完整 Git 差异；不执行文件回滚。 */
      readonly toolNote: string;
      /** 当前会话尚无工具调用。 */
      readonly noToolCalls: string;
    };
    readonly modal: {
      /** 关闭对话框 */
      readonly close: string;
    };
    readonly dialog: {
      /** 重命名会话 */
      readonly renameTitle: string;
      /** 归档会话 */
      readonly archiveTitle: string;
      /** 切换为完全授权？ */
      readonly bypassTitle: string;
      /** 会话名称 */
      readonly sessionName: string;
      /** 取消 */
      readonly cancel: string;
      /** 保存名称 */
      readonly saveName: string;
      /** 归档后会话将从项目树隐藏，历史和用量仍然保留。你可以在会话树的“已归档”中恢复。 */
      readonly archiveBody: string;
      /** 完全授权会跳过常规操作审批，允许模型直接执行读写与命令操作。仅在你信任当前项目和任务时使用；内核硬性拒绝规则仍生效。 */
      readonly bypassBody: string;
      /** 确认归档 */
      readonly confirmArchive: string;
      /** 确认完全授权 */
      readonly confirmBypass: string;
    };
    readonly topbar: {
      /** 重命名会话 */
      readonly renameAria: string;
      /** 归档会话 */
      readonly archiveAria: string;
      /** Git 侧栏 */
      readonly gitSidebar: string;
      /** Git 侧栏 */
      readonly gitSidebarTitle: string;
      /** Git 侧栏{badge}，{auth} */
      readonly gitLabel: string;
      /** （{badge}） */
      readonly gitBadge: string;
      /** 切换会话详情 */
      readonly toggleDetail: string;
      /** 会话详情 */
      readonly detailTitle: string;
      /** 关闭错误提示 */
      readonly closeError: string;
      /** 外观：{label} */
      readonly themeAria: string;
      /** 外观：{label}（点击切换） */
      readonly themeTitle: string;
      /** 跟随系统 */
      readonly themeFallback: string;
      /** 工作台 */
      readonly pageFallback: string;
      /** 跟随系统 */
      readonly themeSystem: string;
      /** 浅色 */
      readonly themeLight: string;
      /** 深色 */
      readonly themeDark: string;
    };
    readonly status: {
      /** 载入中 */
      readonly loading: string;
      /** 空闲 */
      readonly idle: string;
      /** 等待审批 */
      readonly awaitingApproval: string;
      /** 运行中 */
      readonly running: string;
    };
    readonly banner: {
      /** 正在启动安全的本地运行时… */
      readonly booting: string;
      /** 连接已断开，正在重新连接。不会自动重发操作。 */
      readonly reconnecting: string;
      /** 本地运行时未连接，暂不可执行操作。 */
      readonly error: string;
    };
  };
  readonly settings: {
    readonly header: {
      /** CHANNEL SETTINGS */
      readonly eyebrow: string;
      /** 渠道与模型 */
      readonly title: string;
      /** 你的模型，你的连接方式。 */
      readonly subtitle: string;
      /** 密钥仅由 Host 环境读取 */
      readonly tag: string;
    };
    readonly language: {
      /** 界面语言 */
      readonly heading: string;
      /** 语言由 Host 配置决定，对所有会话生效。 */
      readonly note: string;
      /** 部分界面文案目前仍只有中文（界面文案正在分模块抽取）；未翻译的地方保持中文，不会显示占位符或空白。 */
      readonly untranslatedNote: string;
      /** 中文 */
      readonly zh: string;
      /** English */
      readonly en: string;
    };
    readonly sidebar: {
      /** 渠道选择 */
      readonly aria: string;
      /** 我的渠道 */
      readonly heading: string;
      /** ＋ 新增 */
      readonly add: string;
      /** 已配置渠道 */
      readonly listAria: string;
      /** 还没有配置渠道。填写右侧表单，创建第一个渠道。 */
      readonly empty: string;
      /** 正在创建新渠道 */
      readonly newHint: string;
      /** 凭据已配置不代表服务可连通。渠道健康请查看真实请求统计。 */
      readonly note: string;
      /** {count} 个模型 · {state} */
      readonly modelCount: string;
      /** 内置演示 */
      readonly builtinDemo: string;
      /** 凭据已配置 */
      readonly credentialReady: string;
      /** 凭据未配置 */
      readonly credentialNotReady: string;
      /** 离线演示 · Mock */
      readonly mockProtocol: string;
    };
    readonly editor: {
      /** 新增渠道 */
      readonly newChannel: string;
      /** 编辑渠道 */
      readonly editChannel: string;
      /** 配置保存到本机 Host，不包含真实 API Key。 */
      readonly caption: string;
      /** 离线演示 */
      readonly demoTag: string;
    };
    readonly connection: {
      /** 连接配置 */
      readonly title: string;
      /** 选择协议并绑定模型服务 */
      readonly subtitle: string;
      /** 渠道 ID */
      readonly idLabel: string;
      /** my-provider */
      readonly idPlaceholder: string;
      /** 创建时自定义唯一 ID，保存后不可修改。 */
      readonly idHelpNew: string;
      /** 现有渠道的稳定标识，不随名称变化。 */
      readonly idHelpExisting: string;
      /** 渠道名称 */
      readonly nameLabel: string;
      /** 我的模型服务 */
      readonly namePlaceholder: string;
      /** API 协议 */
      readonly protocolLabel: string;
      /** Mock · 内置离线演示 */
      readonly protocolMockOption: string;
      /** 内置 Mock 不发送真实模型请求，协议不可修改，也不可创建新的 Mock。 */
      readonly protocolHelpMock: string;
      /** 协议必须与服务实际支持的接口一致。 */
      readonly protocolHelp: string;
      /** Base URL（可选） */
      readonly baseUrlLabel: string;
      /** https://api.example.com/v1 */
      readonly baseUrlPlaceholder: string;
      /** 留空使用协议默认地址。远程仅 HTTPS；不允许 URL 内嵌凭据。 */
      readonly baseUrlHelp: string;
      /** API Key 环境变量名 */
      readonly apiKeyLabel: string;
      /** MY_PROVIDER_API_KEY */
      readonly apiKeyPlaceholder: string;
      /** 只填写变量名，绝不要输入真实 Key。请在启动 Host 的环境中设置该变量，然后重启 Host。网页不会读取或显示变量… */
      readonly apiKeyHelp: string;
      /** Host 报告：凭据已配置（非连通检测） */
      readonly credentialReadyTag: string;
      /** 保存变量名不会自动配置凭据 */
      readonly credentialNotReadyTag: string;
    };
    readonly models: {
      /** 模型目录 */
      readonly title: string;
      /** 真实模型 ID · 用户配置的容量与定价 */
      readonly subtitle: string;
      /** ＋ 添加模型 */
      readonly add: string;
      /** 价格单位均为 USD / 百万 tokens。未知价格或容量请留空；留空不等于免费，也不会自动填入厂商价格。 */
      readonly note: string;
      /** 模型 {index} */
      readonly rowLegend: string;
      /** 未命名模型 */
      readonly unnamed: string;
      /** 移除模型 {index}{name} */
      readonly removeAria: string;
      /**  {name} */
      readonly removeNameSuffix: string;
      /** 移除此模型 */
      readonly remove: string;
      /** 模型 ID */
      readonly idLabel: string;
      /** 服务商提供的真实模型 ID */
      readonly idPlaceholder: string;
      /** 显示名称 */
      readonly nameLabel: string;
      /** 用于界面显示的名称 */
      readonly namePlaceholder: string;
      /** 上下文容量 (tokens) */
      readonly fieldContextWindow: string;
      /** 输入 (USD / 百万) */
      readonly fieldInputPrice: string;
      /** 输出 (USD / 百万) */
      readonly fieldOutputPrice: string;
      /** 缓存读取 (USD / 百万) */
      readonly fieldCacheReadPrice: string;
      /** 未提供 */
      readonly notProvided: string;
    };
    readonly snapshot: {
      /** 余额与配额 */
      readonly title: string;
      /** 手动账户快照 · 非实时账单 */
      readonly subtitle: string;
      /** 来源：手动 */
      readonly manualTag: string;
      /** 余额快照 */
      readonly balanceHeading: string;
      /** 尚未录入快照 */
      readonly never: string;
      /** 上次手动记录：{time} */
      readonly lastManual: string;
      /** 余额金额 */
      readonly balanceAmount: string;
      /** 留空清除余额快照；0 表示明确的零余额。 */
      readonly balanceHelp: string;
      /** 币种 */
      readonly currencyLabel: string;
      /** USD · 美元 */
      readonly currencyUsd: string;
      /** CNY · 人民币 */
      readonly currencyCny: string;
      /** 不同币种独立记录，不自动换汇。 */
      readonly currencyHelp: string;
      /** 配额快照 */
      readonly quotaHeading: string;
      /** 已使用额度 */
      readonly quotaUsed: string;
      /** 可以达到或超过上限；不会自动截断。 */
      readonly quotaUsedHelp: string;
      /** 额度上限 */
      readonly quotaLimit: string;
      /** 录入时必须大于 0，并同时填写已使用额度。 */
      readonly quotaLimitHelp: string;
      /** 配额单位 */
      readonly quotaUnitLabel: string;
      /** requests · 请求 */
      readonly unitRequests: string;
      /** credits · 积分 */
      readonly unitCredits: string;
      /** 重置时间（本地，可选） */
      readonly resetsAt: string;
      /** 清空“已使用额度 / 额度上限 / 重置时间”可清除配额快照。保存时记录当前时间和手动来源；不会调用上游账单 API。 */
      readonly note: string;
    };
    readonly save: {
      /** 请检查标出的字段，尚未保存任何更改。 */
      readonly invalid: string;
      /** 保存成功。渠道列表与凭据状态以 Host 返回的配置为准。 */
      readonly success: string;
      /** 保存失败：{message} */
      readonly failed: string;
      /** Host 未能保存配置，请稍后重试。 */
      readonly failedDefault: string;
      /** 保存未完成，请检查提示与标出的字段。 */
      readonly notSaved: string;
      /** 仅保存配置与手动快照，不保存任何真实密钥。 */
      readonly onlyConfig: string;
      /** 正在保存… */
      readonly saving: string;
      /** 创建渠道 */
      readonly create: string;
      /** 保存更改 */
      readonly update: string;
    };
    readonly error: {
      /** 使用字母、数字、点、短横线或下划线，并以字母或数字开头。 */
      readonly idFormat: string;
      /** 现有渠道 ID 不可修改；请通过新增创建另一个渠道。 */
      readonly idImmutable: string;
      /** 此渠道 ID 已存在，请选择其他 ID。 */
      readonly idTaken: string;
      /** 请输入渠道名称。 */
      readonly nameRequired: string;
      /** 内置 Mock 的协议不可修改。 */
      readonly mockProtocolLocked: string;
      /** 请选择 OpenAI-compatible 或 Anthropic 协议；不可创建 Mock。 */
      readonly protocolChoice: string;
      /** mock 是内置离线演示渠道的保留 ID。 */
      readonly mockReserved: string;
      /** URL 不可包含用户名、密码、查询参数或片段；密钥请由 Host 环境变量提供。 */
      readonly baseUrlParts: string;
      /** 远程服务必须使用 HTTPS；仅本机回环地址允许 HTTP。 */
      readonly baseUrlHttps: string;
      /** 请输入完整有效的 URL（含 https://）。 */
      readonly baseUrlInvalid: string;
      /** 请输入 Host 读取的环境变量名，不要输入真实 API Key。 */
      readonly apiKeyRequired: string;
      /** 仅填写环境变量名，例如 MY_PROVIDER_API_KEY；不要粘贴密钥。 */
      readonly apiKeyFormat: string;
      /** 请填写此数值；若不录入配额，请将配额字段全部留空。 */
      readonly numberRequired: string;
      /** 请输入有限的非负数，不可填写负数、Infinity 或非数字。 */
      readonly numberInvalid: string;
      /** 额度上限必须大于 0。 */
      readonly quotaPositive: string;
      /** 上下文容量必须为安全范围内的非负整数。 */
      readonly contextInteger: string;
      /** 至少添加一个可用模型。 */
      readonly modelsEmpty: string;
      /** 填写真实模型 ID，不可包含空白或控制字符。 */
      readonly modelIdInvalid: string;
      /** 同一渠道内模型 ID 不可重复。 */
      readonly modelIdDuplicate: string;
      /** 请输入模型显示名称。 */
      readonly modelNameRequired: string;
      /** 币种仅支持 USD 或 CNY。 */
      readonly currencyInvalid: string;
      /** 请选择有效的配额单位。 */
      readonly quotaUnitInvalid: string;
      /** 请选择有效的本地重置日期和时间。 */
      readonly resetsAtInvalid: string;
    };
  };
  readonly usage: {
    readonly header: {
      /** WORKSPACE ANALYTICS */
      readonly eyebrow: string;
      /** 用量统计 */
      readonly title: string;
      /** 每一次请求，都有迹可循。 */
      readonly subtitle: string;
      /** 本地用量账本 */
      readonly tag: string;
    };
    readonly toolbar: {
      /** 日期预设 */
      readonly presetAria: string;
      /** 今天 */
      readonly today: string;
      /** 近 7 天 */
      readonly last7d: string;
      /** 近 30 天 */
      readonly last30d: string;
      /** 开始日期 */
      readonly startDate: string;
      /** 结束日期（含全天） */
      readonly endDate: string;
      /** 项目 */
      readonly project: string;
      /** 全部项目 */
      readonly allProjects: string;
      /** {root}（未登记） */
      readonly unregistered: string;
    };
    readonly status: {
      /** 正在刷新，当前显示上次查询结果… */
      readonly refreshing: string;
      /** 正在加载用量报告… */
      readonly loading: string;
      /** {from} — {to} · 本地日期，结束日含全天 */
      readonly range: string;
      /** 尚未收到用量报告 */
      readonly none: string;
      /** 自定义范围 */
      readonly custom: string;
    };
    /** 包含 Mock 离线演示数据：测试用量不代表真实模型调用或账单。 */
    readonly mockNotice: string;
    readonly metric: {
      /** Tokens */
      readonly tokens: string;
      /** 成本 (USD) */
      readonly cost: string;
      /** 成本 */
      readonly costShort: string;
      /** 请求数 */
      readonly requests: string;
    };
    readonly kpi: {
      /** 总 Tokens */
      readonly totalTokens: string;
      /** 输入 Tokens */
      readonly inputTokens: string;
      /** 输出 Tokens */
      readonly outputTokens: string;
      /** 缓存读取 */
      readonly cacheRead: string;
      /** 缓存命中率 */
      readonly cacheHitRate: string;
      /** 活跃会话 */
      readonly activeSessions: string;
      /** 活跃渠道 */
      readonly activeChannels: string;
      /** 成本 · USD */
      readonly cost: string;
      /** 请求数 */
      readonly requests: string;
      /** 错误率 */
      readonly errorRate: string;
      /** 已知小计 · {count} 次用量未提供 */
      readonly knownSubtotal: string;
      /** 输入 + 输出，不重复计缓存 */
      readonly inputPlusOutput: string;
      /** 含缓存读取，不重复累加 */
      readonly inputIncludesCache: string;
      /** 模型生成的输出 */
      readonly outputGenerated: string;
      /** 上报不完整，无法确定命中率 */
      readonly cacheIncomplete: string;
      /** 缓存读取 / 输入 Tokens */
      readonly cacheFormula: string;
      /** 范围内有请求的会话，去重 */
      readonly sessionsNote: string;
      /** 范围内实际发起请求的渠道 */
      readonly channelsNote: string;
      /** 按 Provider 调用计数{cancelled} */
      readonly requestsNote: string;
      /**  · {count} 次取消 */
      readonly requestsCancelled: string;
      /** 错误请求 / 全部请求，不含取消 */
      readonly errorsNote: string;
      /** 未提供 */
      readonly notProvided: string;
    };
    readonly coverage: {
      /** 等待用量报告 */
      readonly waiting: string;
      /** 暂无请求记录 */
      readonly noRequests: string;
      /** 部分已知 */
      readonly partialKnown: string;
      /** 成本未提供 */
      readonly costUnknown: string;
      /** 已知成本 */
      readonly known: string;
      /** {state} · 覆盖 {percent} ({known}/{total} 次) */
      readonly costLine: string;
      /** 暂无缓存上报 */
      readonly noCache: string;
      /** 上报覆盖 */
      readonly cacheCovered: string;
      /** 部分覆盖 */
      readonly cachePartial: string;
      /** {state} · {reported}/{total} 次请求 */
      readonly cacheLine: string;
      /** 暂无请求记录 */
      readonly healthNoRequests: string;
      /** 错误率 {percent} */
      readonly healthErrors: string;
      /** 历史请求无错误 */
      readonly healthOk: string;
    };
    readonly chart: {
      /** 每日活跃会话 */
      readonly dailyActiveSessions: string;
      /** {metric} 趋势 */
      readonly trendOf: string;
      /** 按本地日期统计。横轴为日期，纵轴为{axis}。精确值见下方每日明细；未知值留空，不按零绘制。 */
      readonly desc: string;
      /** 会话数 */
      readonly axisSessions: string;
      /** {date} · {value} 个活跃会话 */
      readonly pointSessions: string;
      /** {date} · {metric} {value} */
      readonly pointValue: string;
      /** {base}；{coverage} */
      readonly pointWithCoverage: string;
      /** 等待用量报告 */
      readonly emptyWaiting: string;
      /** 所选范围暂无请求记录 */
      readonly emptyNoRequests: string;
      /** 该指标尚未提供 */
      readonly emptyUnknown: string;
      /** 有请求的会话（每日去重） */
      readonly legendSessions: string;
      /** 仅绘制已知成本，缺失值留空 */
      readonly legendCostNote: string;
      /** 按请求发生的本地日期 */
      readonly legendDateNote: string;
      /** 用量趋势 */
      readonly trendTitle: string;
      /** 观察每天的工作节奏 */
      readonly trendCaption: string;
      /** 趋势指标 */
      readonly metricAria: string;
      /** 会话活跃 */
      readonly activityTitle: string;
      /** 每日去重，不可跨日相加 */
      readonly activityCaption: string;
      /**  个会话 */
      readonly sessionUnit: string;
    };
    readonly distribution: {
      /** 模型 */
      readonly models: string;
      /** 项目 */
      readonly projects: string;
      /** 按已知 Tokens */
      readonly byKnownTokens: string;
      /** {title}分布 */
      readonly title: string;
      /** {title} Tokens 分布，总计 {total}。各分组数值见图例和明细表。 */
      readonly donutTitle: string;
      /** 未提供 */
      readonly notProvided: string;
      /** 已知 Tokens */
      readonly knownTokens: string;
      /** {title}分布图例 */
      readonly legendAria: string;
      /** 暂无分组数据 */
      readonly emptyGroups: string;
      /** 等待用量报告 */
      readonly waiting: string;
      /** {title}用量明细，可横向滚动 */
      readonly regionAria: string;
      /** {title}用量明细 · 精确值 */
      readonly caption: string;
      /** 请求 */
      readonly tableRequests: string;
      /** 输入 / 输出 */
      readonly tableTokens: string;
      /** 缓存读取 */
      readonly tableCache: string;
      /** 成本 (USD) */
      readonly tableCost: string;
      /** 所选范围暂无记录 */
      readonly emptyRange: string;
      /** {count} 次错误 */
      readonly errorsSuffix: string;
      /** {count} 次用量未知 */
      readonly unknownUsageSuffix: string;
    };
    readonly health: {
      /** 渠道健康 */
      readonly title: string;
      /** 当前筛选范围的请求结果，不代表实时连通性 */
      readonly caption: string;
      /** 本地请求观测 */
      readonly tag: string;
      /** 暂无渠道配置或历史请求。 */
      readonly empty: string;
      /** 等待报告 */
      readonly waiting: string;
      /** 凭据已配置 · 未检测连通性 */
      readonly credentialReady: string;
      /** 凭据未配置 */
      readonly credentialNotReady: string;
      /** 历史渠道 · 当前未配置 */
      readonly historyOnly: string;
      /** 请求数 */
      readonly requests: string;
      /** 错误 */
      readonly errors: string;
      /** 取消 */
      readonly cancelled: string;
      /** 账户余额 */
      readonly balance: string;
      /** 手动录入 · {time} · 非实时 */
      readonly manualEntry: string;
      /** 未接入账单 API；不从本地成本推算余额 */
      readonly noBillingApi: string;
      /** 手动配额 · {unit} */
      readonly quotaLabel: string;
      /** {name} 手动配额使用量 */
      readonly quotaProgressAria: string;
      /** 记录于 {time} */
      readonly recordedAt: string;
      /**  · 已达额度上限 */
      readonly atLimit: string;
      /**  · 重置 {time} */
      readonly resetsAt: string;
      /** 配额未提供 */
      readonly quotaMissing: string;
      /** 时间未提供 */
      readonly timeMissing: string;
      /** 离线演示 · Mock */
      readonly mockDemo: string;
    };
    readonly daily: {
      /** 每日用量明细 */
      readonly summary: string;
      /** 趋势与活跃图的精确数值 */
      readonly summaryNote: string;
      /** 每日用量明细，可横向滚动 */
      readonly regionAria: string;
      /** 同一筛选结果的按日统计 */
      readonly caption: string;
      /** 日期 */
      readonly columnDate: string;
      /** Tokens */
      readonly columnTokens: string;
      /** 成本 (USD) */
      readonly columnCost: string;
      /** 请求 */
      readonly columnRequests: string;
      /** 错误 / 取消 */
      readonly columnErrors: string;
      /** 活跃会话 */
      readonly columnSessions: string;
      /** 所选范围暂无记录 */
      readonly emptyRange: string;
      /** 等待用量报告 */
      readonly waiting: string;
    };
    /** 统计来自当前查询的同一份请求报告。Tokens 为已上报用量；输入已包含缓存。成本为 USD 已知金额（可能采用用户配置… */
    readonly footnote: string;
    readonly aria: {
      /** 用量概览，10 项指标 */
      readonly kpiGrid: string;
    };
    readonly error: {
      /** 请选择有效的开始日期和结束日期。 */
      readonly dateRangeRequired: string;
      /** 开始日期不能晚于结束日期，请调整日期范围。 */
      readonly dateOrder: string;
    };
  };
}

const zh: ViewsMessages = {  workbench: {
    nav: {
      chat: '工作台',
      usage: '用量统计',
      sessions: '会话树',
      files: '变更与文件',
      agents: 'Agent 群',
      resources: 'MCP 服务',
      settings: '渠道与设置',
    },
    caption: {
      monitor: '监控',
      sessions: '会话',
      resources: '资源',
    },
    brand: {
      subtitle: 'DESKTOP · 本地工作台',
    },
    sidebar: {
      mainNav: '主导航',
      newSession: '新建会话',
      searchAria: '搜索会话',
      searchPlaceholder: '搜索会话与项目',
      clearSearch: '清空搜索',
      projects: '项目',
      addProject: '添加项目',
      addProjectTitle: '添加项目目录',
      myProjects: '我的项目',
      sessionCount: '{count} 会话',
      expand: '展开 {name}',
      collapse: '收起 {name}',
      noMatchingSessions: '没有匹配的会话',
      noSessions: '尚无会话',
      noMatchingAtAll: '未找到匹配的会话',
      runtimeNotConnected: '运行时未连接',
      loadingProjects: '正在载入项目…',
      accountSummary: '余额与配额',
      todayTokens: '今日 {tokens} tokens',
      offlineDemo: '离线演示',
      balanceUnknown: '余额未提供',
      manualRecord: '手动记录 · {date}',
      credentialReadyQuotaUnknown: '凭据就绪 · 配额未提供',
      credentialNotConfigured: '未配置凭据 · 点击设置',
      localWorkspace: '本地工作空间',
      statusConnected: '运行时已连接',
      statusFailed: '连接失败',
      statusReconnecting: '正在重新连接',
      statusBooting: '正在启动',
      running: '运行中',
      channelsAndSettings: '渠道与设置',
    },
    picker: {
      aria: '选择渠道与模型',
      channelColumn: '渠道',
      modelsOf: '模型 · {name}',
      manageChannels: '管理渠道与凭据 →',
      reasoningLabel: '思考等级',
      modelDefault: '模型默认',
      reasoningNote: '当前 Agent 适配器未接入思考预算控制，不发送无效参数。',
      offlineDemo: '离线演示',
      noModels: '尚无模型，请在设置中添加真实模型 ID。',
      needCredential: '请先配置渠道凭据',
      contextWindow: ' · {tokens} 上下文',
      choosePlaceholder: '选择渠道与模型',
    },
    welcome: {
      openingSession: '正在打开会话',
      eyebrow: 'YOUR LOCAL CODING WORKSPACE',
      title: '从一个想法，开始构建。',
      body: '理解代码、规划方案、执行任务。',
      bodySecond: '每个项目的上下文与会话，都在这里井然有序。',
      chooseProject: '先选择一个项目',
      switchDirectory: '切换目录',
      createSession: '在此项目新建会话',
      starterUnderstand: '理解项目',
      starterUnderstandPrompt: '请先阅读当前项目，梳理目录结构与主要模块，不要修改代码。',
      starterPlan: '规划改动',
      starterPlanPrompt: '请先分析项目现状，帮我制定分步骤的开发和验证计划。',
      starterReview: '检查代码',
      starterReviewPrompt: '请检查当前项目可能存在的问题，给出有文件依据的改进建议。',
      starterHint: '从清晰的上下文开始 →',
      notice: '本地会话自动保存 · 需要授权的工具操作会先询问你',
      noticeAsking: '本地会话自动保存 · 需要授权的工具操作会先询问你',
      noticeNotAsking: '本地会话自动保存 · 当前权限档位不逐次询问（输入区可切换）',
    },
    conversation: {
      shellLines: '本地命令记录（未发送给模型）',
      shellEmpty: '请在 ! 后输入要执行的命令。',
      shellBusy: '上一条本地命令仍在执行，请稍候。',
      focusPermissionFailed: '当前无法聚焦权限选择（会话运行中或未连接）。',
      noRunningTurn: '当前没有正在运行的轮次。',
      noSessionToArchive: '还没有可归档的会话。',
      permissionAria: '会话权限',
      stopRunning: '停止运行',
      mockFootnote: '离线演示模型 · 不会调用真实厂商 API',
      modelFootnote: '模型输出仅供参考，工具执行由权限引擎控制',
      enterHint: 'Enter 发送 · Shift Enter 换行',
    },
    permission: {
      plan: '只读规划',
      strict: '严格审批',
      default: '标准权限',
      acceptEdits: '自动编辑',
      bypass: '完全授权',
    },
    sessions: {
      title: '会话树',
      subtitle: '按项目组织工作，随时回到未完成的思考。',
      newSession: '新建会话',
      tabActive: '进行中的会话',
      tabArchived: '已归档',
      emptyNoMatch: '没有匹配的会话',
      emptyArchived: '暂无归档会话',
      emptyFirst: '创建你的第一个会话',
      emptyBody: '会话保存在本机，不会因为关闭窗口而消失。',
      restore: '恢复会话',
      idle: '空闲',
      running: '运行中',
      count: '{count} 会话',
      turns: '{model} · {count} 轮 · {time}',
    },
    files: {
      title: '变更与文件',
      tabFiles: '项目文件',
      tabTools: '本会话工具记录',
      readingTree: '正在读取目录…',
      emptyTree: '目录为空或尚未添加项目',
      preview: '文件预览',
      readOnly: '只读',
      reading: '正在读取…',
      pickFile: '选择一个文件查看内容',
      sensitiveNote: '敏感文件及工作区外路径不可读取',
      truncated: '\n\n[文件已按读取上限截断]',
      toolNote: '这是本会话的真实工具执行记录，不代表完整 Git 差异；不执行文件回滚。',
      noToolCalls: '当前会话尚无工具调用。',
    },
    modal: {
      close: '关闭对话框',
    },
    dialog: {
      renameTitle: '重命名会话',
      archiveTitle: '归档会话',
      bypassTitle: '切换为完全授权？',
      sessionName: '会话名称',
      cancel: '取消',
      saveName: '保存名称',
      archiveBody: '归档后会话将从项目树隐藏，历史和用量仍然保留。你可以在会话树的“已归档”中恢复。',
      bypassBody: '完全授权会跳过常规操作审批，允许模型直接执行读写与命令操作。仅在你信任当前项目和任务时使用；内核硬性拒绝规则仍生效，敏感路径（工作区密钥、凭据目录）仍会逐次询问。',
      confirmArchive: '确认归档',
      confirmBypass: '确认完全授权',
    },
    topbar: {
      renameAria: '重命名会话',
      archiveAria: '归档会话',
      gitSidebar: 'Git 侧栏',
      gitSidebarTitle: 'Git 侧栏',
      gitLabel: 'Git 侧栏{badge}，{auth}',
      gitBadge: '（{badge}）',
      toggleDetail: '切换会话详情',
      detailTitle: '会话详情',
      closeError: '关闭错误提示',
      themeAria: '外观：{label}',
      themeTitle: '外观：{label}（点击切换）',
      themeFallback: '跟随系统',
      pageFallback: '工作台',
      themeSystem: '跟随系统',
      themeLight: '浅色',
      themeDark: '深色',
    },
    status: {
      loading: '载入中',
      idle: '空闲',
      awaitingApproval: '等待审批',
      running: '运行中',
    },
    banner: {
      booting: '正在启动安全的本地运行时…',
      reconnecting: '连接已断开，正在重新连接。不会自动重发操作。',
      error: '本地运行时未连接，暂不可执行操作。',
    },
  },
  settings: {
    header: {
      eyebrow: 'CHANNEL SETTINGS',
      title: '渠道与模型',
      subtitle: '你的模型，你的连接方式。',
      tag: '密钥仅由 Host 环境读取',
    },
    language: {
      heading: '界面语言',
      note: '语言由 Host 配置决定，对所有会话生效。',
      untranslatedNote: '部分界面文案目前仍只有中文（界面文案正在分模块抽取）；未翻译的地方保持中文，不会显示占位符或空白。',
      zh: '中文',
      en: 'English',
    },
    sidebar: {
      aria: '渠道选择',
      heading: '我的渠道',
      add: '＋ 新增',
      listAria: '已配置渠道',
      empty: '还没有配置渠道。填写右侧表单，创建第一个渠道。',
      newHint: '正在创建新渠道',
      note: '凭据已配置不代表服务可连通。渠道健康请查看真实请求统计。',
      modelCount: '{count} 个模型 · {state}',
      builtinDemo: '内置演示',
      credentialReady: '凭据已配置',
      credentialNotReady: '凭据未配置',
      mockProtocol: '离线演示 · Mock',
    },
    editor: {
      newChannel: '新增渠道',
      editChannel: '编辑渠道',
      caption: '配置保存到本机 Host，不包含真实 API Key。',
      demoTag: '离线演示',
    },
    connection: {
      title: '连接配置',
      subtitle: '选择协议并绑定模型服务',
      idLabel: '渠道 ID',
      idPlaceholder: 'my-provider',
      idHelpNew: '创建时自定义唯一 ID，保存后不可修改。',
      idHelpExisting: '现有渠道的稳定标识，不随名称变化。',
      nameLabel: '渠道名称',
      namePlaceholder: '我的模型服务',
      protocolLabel: 'API 协议',
      protocolMockOption: 'Mock · 内置离线演示',
      protocolHelpMock: '内置 Mock 不发送真实模型请求，协议不可修改，也不可创建新的 Mock。',
      protocolHelp: '协议必须与服务实际支持的接口一致。',
      baseUrlLabel: 'Base URL（可选）',
      baseUrlPlaceholder: 'https://api.example.com/v1',
      baseUrlHelp: '留空使用协议默认地址。远程仅 HTTPS；不允许 URL 内嵌凭据。',
      apiKeyLabel: 'API Key 环境变量名',
      apiKeyPlaceholder: 'MY_PROVIDER_API_KEY',
      apiKeyHelp: '只填写变量名，绝不要输入真实 Key。请在启动 Host 的环境中设置该变量，然后重启 Host。网页不会读取或显示变量值。',
      credentialReadyTag: 'Host 报告：凭据已配置（非连通检测）',
      credentialNotReadyTag: '保存变量名不会自动配置凭据',
    },
    models: {
      title: '模型目录',
      subtitle: '真实模型 ID · 用户配置的容量与定价',
      add: '＋ 添加模型',
      note: '价格单位均为 USD / 百万 tokens。未知价格或容量请留空；留空不等于免费，也不会自动填入厂商价格。',
      rowLegend: '模型 {index}',
      unnamed: '未命名模型',
      removeAria: '移除模型 {index}{name}',
      removeNameSuffix: ' {name}',
      remove: '移除此模型',
      idLabel: '模型 ID',
      idPlaceholder: '服务商提供的真实模型 ID',
      nameLabel: '显示名称',
      namePlaceholder: '用于界面显示的名称',
      fieldContextWindow: '上下文容量 (tokens)',
      fieldInputPrice: '输入 (USD / 百万)',
      fieldOutputPrice: '输出 (USD / 百万)',
      fieldCacheReadPrice: '缓存读取 (USD / 百万)',
      notProvided: '未提供',
    },
    snapshot: {
      title: '余额与配额',
      subtitle: '手动账户快照 · 非实时账单',
      manualTag: '来源：手动',
      balanceHeading: '余额快照',
      never: '尚未录入快照',
      lastManual: '上次手动记录：{time}',
      balanceAmount: '余额金额',
      balanceHelp: '留空清除余额快照；0 表示明确的零余额。',
      currencyLabel: '币种',
      currencyUsd: 'USD · 美元',
      currencyCny: 'CNY · 人民币',
      currencyHelp: '不同币种独立记录，不自动换汇。',
      quotaHeading: '配额快照',
      quotaUsed: '已使用额度',
      quotaUsedHelp: '可以达到或超过上限；不会自动截断。',
      quotaLimit: '额度上限',
      quotaLimitHelp: '录入时必须大于 0，并同时填写已使用额度。',
      quotaUnitLabel: '配额单位',
      unitRequests: 'requests · 请求',
      unitCredits: 'credits · 积分',
      resetsAt: '重置时间（本地，可选）',
      note: '清空“已使用额度 / 额度上限 / 重置时间”可清除配额快照。保存时记录当前时间和手动来源；不会调用上游账单 API。',
    },
    save: {
      invalid: '请检查标出的字段，尚未保存任何更改。',
      success: '保存成功。渠道列表与凭据状态以 Host 返回的配置为准。',
      failed: '保存失败：{message}',
      failedDefault: 'Host 未能保存配置，请稍后重试。',
      notSaved: '保存未完成，请检查提示与标出的字段。',
      onlyConfig: '仅保存配置与手动快照，不保存任何真实密钥。',
      saving: '正在保存…',
      create: '创建渠道',
      update: '保存更改',
    },
    error: {
      idFormat: '使用字母、数字、点、短横线或下划线，并以字母或数字开头。',
      idImmutable: '现有渠道 ID 不可修改；请通过新增创建另一个渠道。',
      idTaken: '此渠道 ID 已存在，请选择其他 ID。',
      nameRequired: '请输入渠道名称。',
      mockProtocolLocked: '内置 Mock 的协议不可修改。',
      protocolChoice: '请选择 OpenAI-compatible 或 Anthropic 协议；不可创建 Mock。',
      mockReserved: 'mock 是内置离线演示渠道的保留 ID。',
      baseUrlParts: 'URL 不可包含用户名、密码、查询参数或片段；密钥请由 Host 环境变量提供。',
      baseUrlHttps: '远程服务必须使用 HTTPS；仅本机回环地址允许 HTTP。',
      baseUrlInvalid: '请输入完整有效的 URL（含 https://）。',
      apiKeyRequired: '请输入 Host 读取的环境变量名，不要输入真实 API Key。',
      apiKeyFormat: '仅填写环境变量名，例如 MY_PROVIDER_API_KEY；不要粘贴密钥。',
      numberRequired: '请填写此数值；若不录入配额，请将配额字段全部留空。',
      numberInvalid: '请输入有限的非负数，不可填写负数、Infinity 或非数字。',
      quotaPositive: '额度上限必须大于 0。',
      contextInteger: '上下文容量必须为安全范围内的非负整数。',
      modelsEmpty: '至少添加一个可用模型。',
      modelIdInvalid: '填写真实模型 ID，不可包含空白或控制字符。',
      modelIdDuplicate: '同一渠道内模型 ID 不可重复。',
      modelNameRequired: '请输入模型显示名称。',
      currencyInvalid: '币种仅支持 USD 或 CNY。',
      quotaUnitInvalid: '请选择有效的配额单位。',
      resetsAtInvalid: '请选择有效的本地重置日期和时间。',
    },
  },
  usage: {
    header: {
      eyebrow: 'WORKSPACE ANALYTICS',
      title: '用量统计',
      subtitle: '每一次请求，都有迹可循。',
      tag: '本地用量账本',
    },
    toolbar: {
      presetAria: '日期预设',
      today: '今天',
      last7d: '近 7 天',
      last30d: '近 30 天',
      startDate: '开始日期',
      endDate: '结束日期（含全天）',
      project: '项目',
      allProjects: '全部项目',
      unregistered: '{root}（未登记）',
    },
    status: {
      refreshing: '正在刷新，当前显示上次查询结果…',
      loading: '正在加载用量报告…',
      range: '{from} — {to} · 本地日期，结束日含全天',
      none: '尚未收到用量报告',
      custom: '自定义范围',
    },
    mockNotice: '包含 Mock 离线演示数据：测试用量不代表真实模型调用或账单。',
    metric: {
      tokens: 'Tokens',
      cost: '成本 (USD)',
      costShort: '成本',
      requests: '请求数',
    },
    kpi: {
      totalTokens: '总 Tokens',
      inputTokens: '输入 Tokens',
      outputTokens: '输出 Tokens',
      cacheRead: '缓存读取',
      cacheHitRate: '缓存命中率',
      activeSessions: '活跃会话',
      activeChannels: '活跃渠道',
      cost: '成本 · USD',
      requests: '请求数',
      errorRate: '错误率',
      knownSubtotal: '已知小计 · {count} 次用量未提供',
      inputPlusOutput: '输入 + 输出，不重复计缓存',
      inputIncludesCache: '含缓存读取，不重复累加',
      outputGenerated: '模型生成的输出',
      cacheIncomplete: '上报不完整，无法确定命中率',
      cacheFormula: '缓存读取 / 输入 Tokens',
      sessionsNote: '范围内有请求的会话，去重',
      channelsNote: '范围内实际发起请求的渠道',
      requestsNote: '按 Provider 调用计数{cancelled}',
      requestsCancelled: ' · {count} 次取消',
      errorsNote: '错误请求 / 全部请求，不含取消',
      notProvided: '未提供',
    },
    coverage: {
      waiting: '等待用量报告',
      noRequests: '暂无请求记录',
      partialKnown: '部分已知',
      costUnknown: '成本未提供',
      known: '已知成本',
      costLine: '{state} · 覆盖 {percent} ({known}/{total} 次)',
      noCache: '暂无缓存上报',
      cacheCovered: '上报覆盖',
      cachePartial: '部分覆盖',
      cacheLine: '{state} · {reported}/{total} 次请求',
      healthNoRequests: '暂无请求记录',
      healthErrors: '错误率 {percent}',
      healthOk: '历史请求无错误',
    },
    chart: {
      dailyActiveSessions: '每日活跃会话',
      trendOf: '{metric} 趋势',
      desc: '按本地日期统计。横轴为日期，纵轴为{axis}。精确值见下方每日明细；未知值留空，不按零绘制。',
      axisSessions: '会话数',
      pointSessions: '{date} · {value} 个活跃会话',
      pointValue: '{date} · {metric} {value}',
      pointWithCoverage: '{base}；{coverage}',
      emptyWaiting: '等待用量报告',
      emptyNoRequests: '所选范围暂无请求记录',
      emptyUnknown: '该指标尚未提供',
      legendSessions: '有请求的会话（每日去重）',
      legendCostNote: '仅绘制已知成本，缺失值留空',
      legendDateNote: '按请求发生的本地日期',
      trendTitle: '用量趋势',
      trendCaption: '观察每天的工作节奏',
      metricAria: '趋势指标',
      activityTitle: '会话活跃',
      activityCaption: '每日去重，不可跨日相加',
      sessionUnit: ' 个会话',
    },
    distribution: {
      models: '模型',
      projects: '项目',
      byKnownTokens: '按已知 Tokens',
      title: '{title}分布',
      donutTitle: '{title} Tokens 分布，总计 {total}。各分组数值见图例和明细表。',
      notProvided: '未提供',
      knownTokens: '已知 Tokens',
      legendAria: '{title}分布图例',
      emptyGroups: '暂无分组数据',
      waiting: '等待用量报告',
      regionAria: '{title}用量明细，可横向滚动',
      caption: '{title}用量明细 · 精确值',
      tableRequests: '请求',
      tableTokens: '输入 / 输出',
      tableCache: '缓存读取',
      tableCost: '成本 (USD)',
      emptyRange: '所选范围暂无记录',
      errorsSuffix: '{count} 次错误',
      unknownUsageSuffix: '{count} 次用量未知',
    },
    health: {
      title: '渠道健康',
      caption: '当前筛选范围的请求结果，不代表实时连通性',
      tag: '本地请求观测',
      empty: '暂无渠道配置或历史请求。',
      waiting: '等待报告',
      credentialReady: '凭据已配置 · 未检测连通性',
      credentialNotReady: '凭据未配置',
      historyOnly: '历史渠道 · 当前未配置',
      requests: '请求数',
      errors: '错误',
      cancelled: '取消',
      balance: '账户余额',
      manualEntry: '手动录入 · {time} · 非实时',
      noBillingApi: '未接入账单 API；不从本地成本推算余额',
      quotaLabel: '手动配额 · {unit}',
      quotaProgressAria: '{name} 手动配额使用量',
      recordedAt: '记录于 {time}',
      atLimit: ' · 已达额度上限',
      resetsAt: ' · 重置 {time}',
      quotaMissing: '配额未提供',
      timeMissing: '时间未提供',
      mockDemo: '离线演示 · Mock',
    },
    daily: {
      summary: '每日用量明细',
      summaryNote: '趋势与活跃图的精确数值',
      regionAria: '每日用量明细，可横向滚动',
      caption: '同一筛选结果的按日统计',
      columnDate: '日期',
      columnTokens: 'Tokens',
      columnCost: '成本 (USD)',
      columnRequests: '请求',
      columnErrors: '错误 / 取消',
      columnSessions: '活跃会话',
      emptyRange: '所选范围暂无记录',
      waiting: '等待用量报告',
    },
    footnote: '统计来自当前查询的同一份请求报告。Tokens 为已上报用量；输入已包含缓存。成本为 USD 已知金额（可能采用用户配置单价估算），不是上游账单。余额和配额是独立的手动快照。',
    aria: {
      kpiGrid: '用量概览，10 项指标',
    },
    error: {
      dateRangeRequired: '请选择有效的开始日期和结束日期。',
      dateOrder: '开始日期不能晚于结束日期，请调整日期范围。',
    },
  },

  errors: {
    operationIncomplete: '操作未完成：{status}',
    runtimeNotConnected: '本地运行时未连接，请稍后重试。',
    desktopBridgeMissing: '请通过 LIWENCode 桌面应用启动工作台，本页面需要安全的本机连接。',
    runtimeExited: '本地运行时已退出。请重新启动应用；已保存的会话会在启动后恢复。',
    noSession: '请先创建或选择会话。',
    noWorkspace: '请先选择工作区目录。',
    actionInFlight: '已有操作正在进行，请稍后重试。',
    uploadIncomplete: '上传结果不完整，请重试。',
    noCredentialChannel: '主进程尚未提供凭据通道，令牌不会被保存。',
    noCredentialChannelPlain: '主进程尚未提供凭据通道。',
    noSshCredentialChannel: '主进程尚未提供 SSH 凭据通道。',
    noProject: '请先添加项目目录。',
    sessionBusy: '当前会话仍在执行，请等待完成或停止。',
    newSessionTitle: '新会话',
  },
};
const en: ViewsMessages = {
  workbench: {
    nav: {
      chat: 'Workspace',
      usage: 'Usage',
      sessions: 'Sessions',
      files: 'Changes & files',
      agents: 'Agents',
      resources: 'MCP servers',
      settings: 'Channels & settings',
    },
    caption: {
      monitor: 'Monitor',
      sessions: 'Sessions',
      resources: 'Resources',
    },
    brand: {
      subtitle: 'DESKTOP · local workspace',
    },
    sidebar: {
      mainNav: 'Main navigation',
      newSession: 'New session',
      searchAria: 'Search sessions',
      searchPlaceholder: 'Search sessions and projects',
      clearSearch: 'Clear search',
      projects: 'Projects',
      addProject: 'Add project',
      addProjectTitle: 'Add a project directory',
      myProjects: 'My projects',
      sessionCount: '{count} sessions',
      expand: 'Expand {name}',
      collapse: 'Collapse {name}',
      noMatchingSessions: 'No matching sessions',
      noSessions: 'No sessions yet',
      noMatchingAtAll: 'No matching sessions found',
      runtimeNotConnected: 'Runtime not connected',
      loadingProjects: 'Loading projects…',
      accountSummary: 'Balance and quota',
      todayTokens: 'Today {tokens} tokens',
      offlineDemo: 'Offline demo',
      balanceUnknown: 'Balance not provided',
      manualRecord: 'Manually recorded · {date}',
      credentialReadyQuotaUnknown: 'Credentials ready · quota not provided',
      credentialNotConfigured: 'No credentials · open settings',
      localWorkspace: 'Local workspace',
      statusConnected: 'Runtime connected',
      statusFailed: 'Connection failed',
      statusReconnecting: 'Reconnecting',
      statusBooting: 'Starting',
      running: 'Running',
      channelsAndSettings: 'Channels and settings',
    },
    picker: {
      aria: 'Choose a channel and model',
      channelColumn: 'Channel',
      modelsOf: 'Models · {name}',
      manageChannels: 'Manage channels and credentials →',
      reasoningLabel: 'Reasoning level',
      modelDefault: 'Model default',
      reasoningNote: 'The current agent adapter has no reasoning-budget control, so no ineffective parameters are sent.',
      offlineDemo: 'Offline demo',
      noModels: 'No models yet. Add a real model ID in settings.',
      needCredential: 'Configure the channel credential first',
      contextWindow: ' · {tokens} context',
      choosePlaceholder: 'Choose a channel and model',
    },
    welcome: {
      openingSession: 'Opening the session',
      eyebrow: 'YOUR LOCAL CODING WORKSPACE',
      title: 'Start building from an idea.',
      body: 'Understand the code, plan the change, run the task.',
      bodySecond: 'Every project keeps its context and sessions in order here.',
      chooseProject: 'Choose a project first',
      switchDirectory: 'Switch directory',
      createSession: 'New session in this project',
      starterUnderstand: 'Understand the project',
      starterUnderstandPrompt: 'Read the current project first, outline the directory structure and main modules, and do not modify code.',
      starterPlan: 'Plan a change',
      starterPlanPrompt: 'Analyze the current state of the project, then help me draft a step-by-step development and verification plan.',
      starterReview: 'Review the code',
      starterReviewPrompt: 'Look for possible problems in the current project and give improvement suggestions backed by concrete files.',
      starterHint: 'Start from clear context →',
      notice: 'Local sessions are saved automatically · tool actions that need authorization ask you first',
      noticeAsking: 'Local sessions are saved automatically · tool actions that need authorization ask you first',
      noticeNotAsking: 'Local sessions are saved automatically · the current permission mode does not ask for every action (change it in the input area)',
    },
    conversation: {
      shellLines: 'Local command records (not sent to the model)',
      shellEmpty: 'Type the command to run after `!`.',
      shellBusy: 'The previous local command is still running. Please wait.',
      focusPermissionFailed: 'Cannot focus the permission selector right now (the session is running or not connected).',
      noRunningTurn: 'There is no running turn.',
      noSessionToArchive: 'There is no session to archive yet.',
      permissionAria: 'Session permission',
      stopRunning: 'Stop running',
      mockFootnote: 'Offline demo model · does not call any real vendor API',
      modelFootnote: 'Model output is advisory only; tool execution is governed by the permission engine',
      enterHint: 'Enter to send · Shift+Enter for a newline',
    },
    permission: {
      plan: 'Read-only plan',
      strict: 'Strict approval',
      default: 'Standard permission',
      acceptEdits: 'Auto-edit',
      bypass: 'Full authorization',
    },
    sessions: {
      title: 'Session tree',
      subtitle: 'Organize work by project and return to unfinished thinking at any time.',
      newSession: 'New session',
      tabActive: 'Active sessions',
      tabArchived: 'Archived',
      emptyNoMatch: 'No matching sessions',
      emptyArchived: 'No archived sessions',
      emptyFirst: 'Create your first session',
      emptyBody: 'Sessions are stored on this machine and do not disappear when the window closes.',
      restore: 'Restore session',
      idle: 'Idle',
      running: 'Running',
      count: '{count} sessions',
      turns: '{model} · {count} turns · {time}',
    },
    files: {
      title: 'Changes and files',
      tabFiles: 'Project files',
      tabTools: 'Session tool records',
      readingTree: 'Reading the directory…',
      emptyTree: 'The directory is empty or no project is added yet',
      preview: 'File preview',
      readOnly: 'Read only',
      reading: 'Reading…',
      pickFile: 'Pick a file to see its contents',
      sensitiveNote: 'Sensitive files and paths outside the workspace cannot be read',
      truncated: '\n\n[File truncated at the read limit]',
      toolNote: 'These are the real tool executions of this session; they are not a full Git diff, and no file rollback is performed.',
      noToolCalls: 'This session has no tool calls yet.',
    },
    modal: {
      close: 'Close the dialog',
    },
    dialog: {
      renameTitle: 'Rename session',
      archiveTitle: 'Archive session',
      bypassTitle: 'Switch to full authorization?',
      sessionName: 'Session name',
      cancel: 'Cancel',
      saveName: 'Save name',
      archiveBody: 'After archiving, the session is hidden from the project tree; its history and usage are kept. You can restore it from “Archived” in the session tree.',
      bypassBody: 'Full authorization skips routine approval, letting the model read, write and run commands directly. Use it only when you trust the current project and task; hard denial rules in the kernel still apply, and sensitive paths (workspace secrets, credential directories) still ask every time.',
      confirmArchive: 'Archive',
      confirmBypass: 'Enable full authorization',
    },
    topbar: {
      renameAria: 'Rename session',
      archiveAria: 'Archive session',
      gitSidebar: 'Git sidebar',
      gitSidebarTitle: 'Git sidebar',
      gitLabel: 'Git sidebar{badge}, {auth}',
      gitBadge: ' ({badge})',
      toggleDetail: 'Toggle the session details',
      detailTitle: 'Session details',
      closeError: 'Dismiss the error',
      themeAria: 'Appearance: {label}',
      themeTitle: 'Appearance: {label} (click to switch)',
      themeFallback: 'Follow system',
      pageFallback: 'Workspace',
      themeSystem: 'Follow system',
      themeLight: 'Light',
      themeDark: 'Dark',
    },
    status: {
      loading: 'Loading',
      idle: 'Idle',
      awaitingApproval: 'Awaiting approval',
      running: 'Running',
    },
    banner: {
      booting: 'Starting the secure local runtime…',
      reconnecting: 'The connection dropped and is being re-established. No operation is resent automatically.',
      error: 'The local runtime is not connected, so actions are unavailable.',
    },
  },
  settings: {
    header: {
      eyebrow: 'CHANNEL SETTINGS',
      title: 'Channels and models',
      subtitle: 'Your models, your connections.',
      tag: 'Keys are read only from the Host environment',
    },
    language: {
      heading: 'Interface language',
      note: 'The language comes from the Host configuration and applies to every session.',
      untranslatedNote: 'Some interface copy is still Chinese only (the copy is being extracted module by module); untranslated parts stay in Chinese rather than showing placeholders or blanks.',
      zh: '中文',
      en: 'English',
    },
    sidebar: {
      aria: 'Channel selection',
      heading: 'My channels',
      add: '+ Add',
      listAria: 'Configured channels',
      empty: 'No channels yet. Fill in the form on the right to create your first channel.',
      newHint: 'Creating a new channel',
      note: 'A configured credential does not prove the service is reachable. Check real request statistics for channel health.',
      modelCount: '{count} models · {state}',
      builtinDemo: 'Built-in demo',
      credentialReady: 'Credential configured',
      credentialNotReady: 'Credential not configured',
      mockProtocol: 'Offline demo · Mock',
    },
    editor: {
      newChannel: 'New channel',
      editChannel: 'Edit channel',
      caption: 'The configuration is saved to the local Host and never contains a real API key.',
      demoTag: 'Offline demo',
    },
    connection: {
      title: 'Connection',
      subtitle: 'Pick a protocol and bind a model service',
      idLabel: 'Channel ID',
      idPlaceholder: 'my-provider',
      idHelpNew: 'Choose a unique ID when creating; it cannot change after saving.',
      idHelpExisting: 'The stable identifier of an existing channel; it does not follow the name.',
      nameLabel: 'Channel name',
      namePlaceholder: 'My model service',
      protocolLabel: 'API protocol',
      protocolMockOption: 'Mock · built-in offline demo',
      protocolHelpMock: 'The built-in Mock sends no real model requests; its protocol cannot change and new Mocks cannot be created.',
      protocolHelp: 'The protocol must match the interface the service really supports.',
      baseUrlLabel: 'Base URL (optional)',
      baseUrlPlaceholder: 'https://api.example.com/v1',
      baseUrlHelp: 'Leave empty to use the protocol default. Remote endpoints must use HTTPS; credentials are not allowed inside the URL.',
      apiKeyLabel: 'API key environment variable',
      apiKeyPlaceholder: 'MY_PROVIDER_API_KEY',
      apiKeyHelp: 'Enter the variable name only, never a real key. Set it in the environment that starts the Host, then restart the Host. The page neither reads nor displays the value.',
      credentialReadyTag: 'Host reports: credential configured (not a connectivity check)',
      credentialNotReadyTag: 'Saving the variable name does not configure a credential',
    },
    models: {
      title: 'Model catalog',
      subtitle: 'Real model IDs · capacity and pricing you configure',
      add: '+ Add model',
      note: 'All prices are USD per million tokens. Leave unknown prices or capacity blank; blank does not mean free, and vendor prices are never filled in automatically.',
      rowLegend: 'Model {index}',
      unnamed: 'Unnamed model',
      removeAria: 'Remove model {index}{name}',
      removeNameSuffix: ' {name}',
      remove: 'Remove this model',
      idLabel: 'Model ID',
      idPlaceholder: 'The real model ID from the provider',
      nameLabel: 'Display name',
      namePlaceholder: 'The name shown in the interface',
      fieldContextWindow: 'Context capacity (tokens)',
      fieldInputPrice: 'Input (USD / million)',
      fieldOutputPrice: 'Output (USD / million)',
      fieldCacheReadPrice: 'Cache read (USD / million)',
      notProvided: 'Not provided',
    },
    snapshot: {
      title: 'Balance and quota',
      subtitle: 'Manual account snapshot · not a live bill',
      manualTag: 'Source: manual',
      balanceHeading: 'Balance snapshot',
      never: 'No snapshot recorded yet',
      lastManual: 'Last manual record: {time}',
      balanceAmount: 'Balance amount',
      balanceHelp: 'Leave empty to clear the balance snapshot; 0 means an explicit zero balance.',
      currencyLabel: 'Currency',
      currencyUsd: 'USD · US dollar',
      currencyCny: 'CNY · renminbi',
      currencyHelp: 'Different currencies are recorded separately and never converted automatically.',
      quotaHeading: 'Quota snapshot',
      quotaUsed: 'Quota used',
      quotaUsedHelp: 'It can reach or exceed the limit; values are never clipped automatically.',
      quotaLimit: 'Quota limit',
      quotaLimitHelp: 'Must be greater than 0 and provided together with the used amount.',
      quotaUnitLabel: 'Quota unit',
      unitRequests: 'requests',
      unitCredits: 'credits',
      resetsAt: 'Reset time (local, optional)',
      note: 'Clearing “quota used / quota limit / reset time” removes the quota snapshot. Saving records the current time and the manual source; no upstream billing API is called.',
    },
    save: {
      invalid: 'Check the marked fields; nothing has been saved.',
      success: 'Saved. The channel list and credential state follow the configuration returned by the Host.',
      failed: 'Save failed: {message}',
      failedDefault: 'The Host could not save the configuration. Please try again later.',
      notSaved: 'The save did not finish; check the notice and the marked fields.',
      onlyConfig: 'Only the configuration and manual snapshots are saved; no real key is ever stored.',
      saving: 'Saving…',
      create: 'Create channel',
      update: 'Save changes',
    },
    error: {
      idFormat: 'Use letters, digits, dots, dashes or underscores, starting with a letter or digit.',
      idImmutable: 'An existing channel ID cannot change; add a new channel instead.',
      idTaken: 'This channel ID already exists; choose another one.',
      nameRequired: 'Enter a channel name.',
      mockProtocolLocked: 'The built-in Mock protocol cannot change.',
      protocolChoice: 'Choose the OpenAI-compatible or Anthropic protocol; Mocks cannot be created.',
      mockReserved: '`mock` is reserved for the built-in offline demo channel.',
      baseUrlParts: 'The URL must not contain a user name, password, query string or fragment; provide keys through Host environment variables.',
      baseUrlHttps: 'Remote services must use HTTPS; plain HTTP is allowed only for loopback addresses.',
      baseUrlInvalid: 'Enter a complete, valid URL including https://.',
      apiKeyRequired: 'Enter the environment variable name the Host reads, not a real API key.',
      apiKeyFormat: 'Enter the variable name only, for example MY_PROVIDER_API_KEY; do not paste a key.',
      numberRequired: 'Enter this number, or leave every quota field blank if you do not record a quota.',
      numberInvalid: 'Enter a finite, non-negative number; negative values, Infinity and non-numbers are rejected.',
      quotaPositive: 'The quota limit must be greater than 0.',
      contextInteger: 'Context capacity must be a non-negative integer within the safe range.',
      modelsEmpty: 'Add at least one usable model.',
      modelIdInvalid: 'Enter a real model ID without whitespace or control characters.',
      modelIdDuplicate: 'Model IDs must be unique within a channel.',
      modelNameRequired: 'Enter a display name for the model.',
      currencyInvalid: 'Only USD and CNY are supported.',
      quotaUnitInvalid: 'Choose a valid quota unit.',
      resetsAtInvalid: 'Choose a valid local reset date and time.',
    },
  },
  usage: {
    header: {
      eyebrow: 'WORKSPACE ANALYTICS',
      title: 'Usage',
      subtitle: 'Every request leaves a trace.',
      tag: 'Local usage ledger',
    },
    toolbar: {
      presetAria: 'Date presets',
      today: 'Today',
      last7d: 'Last 7 days',
      last30d: 'Last 30 days',
      startDate: 'Start date',
      endDate: 'End date (whole day)',
      project: 'Project',
      allProjects: 'All projects',
      unregistered: '{root} (not registered)',
    },
    status: {
      refreshing: 'Refreshing; showing the previous query result…',
      loading: 'Loading the usage report…',
      range: '{from} — {to} · local dates, the end day is inclusive',
      none: 'No usage report received yet',
      custom: 'Custom range',
    },
    mockNotice: 'Includes Mock offline demo data: test usage does not represent real model calls or billing.',
    metric: {
      tokens: 'Tokens',
      cost: 'Cost (USD)',
      costShort: 'Cost',
      requests: 'Requests',
    },
    kpi: {
      totalTokens: 'Total tokens',
      inputTokens: 'Input tokens',
      outputTokens: 'Output tokens',
      cacheRead: 'Cache read',
      cacheHitRate: 'Cache hit rate',
      activeSessions: 'Active sessions',
      activeChannels: 'Active channels',
      cost: 'Cost · USD',
      requests: 'Requests',
      errorRate: 'Error rate',
      knownSubtotal: 'Known subtotal · usage unknown for {count} requests',
      inputPlusOutput: 'Input + output; cache is not counted twice',
      inputIncludesCache: 'Includes cache reads without double counting',
      outputGenerated: 'Output generated by the model',
      cacheIncomplete: 'Reporting is incomplete, so the hit rate is unknown',
      cacheFormula: 'Cache reads / input tokens',
      sessionsNote: 'Sessions with requests in range, de-duplicated',
      channelsNote: 'Channels that actually made requests in range',
      requestsNote: 'Counted per provider call{cancelled}',
      requestsCancelled: ' · {count} cancelled',
      errorsNote: 'Failed requests / all requests, excluding cancellations',
      notProvided: 'Not provided',
    },
    coverage: {
      waiting: 'Waiting for the usage report',
      noRequests: 'No request records',
      partialKnown: 'Partly known',
      costUnknown: 'Cost not provided',
      known: 'Known cost',
      costLine: '{state} · coverage {percent} ({known}/{total} requests)',
      noCache: 'No cache reporting yet',
      cacheCovered: 'Reporting covered',
      cachePartial: 'Partly covered',
      cacheLine: '{state} · {reported}/{total} requests',
      healthNoRequests: 'No request records',
      healthErrors: 'Error rate {percent}',
      healthOk: 'No errors in past requests',
    },
    chart: {
      dailyActiveSessions: 'Daily active sessions',
      trendOf: '{metric} trend',
      desc: 'Aggregated by local date. The x axis is the date and the y axis is {axis}. Exact values are in the daily detail below; unknown values are left blank rather than drawn as zero.',
      axisSessions: 'session count',
      pointSessions: '{date} · {value} active sessions',
      pointValue: '{date} · {metric} {value}',
      pointWithCoverage: '{base}; {coverage}',
      emptyWaiting: 'Waiting for the usage report',
      emptyNoRequests: 'No requests in the selected range',
      emptyUnknown: 'This metric is not provided yet',
      legendSessions: 'Sessions with requests (daily, de-duplicated)',
      legendCostNote: 'Only known cost is drawn; missing values stay blank',
      legendDateNote: 'By the local date the request happened',
      trendTitle: 'Usage trend',
      trendCaption: 'Watch the daily rhythm of work',
      metricAria: 'Trend metric',
      activityTitle: 'Session activity',
      activityCaption: 'De-duplicated per day; do not add across days',
      sessionUnit: ' sessions',
    },
    distribution: {
      models: 'Models',
      projects: 'Projects',
      byKnownTokens: 'By known tokens',
      title: '{title} distribution',
      donutTitle: '{title} token distribution, total {total}. Per-group values are in the legend and the detail table.',
      notProvided: 'not provided',
      knownTokens: 'Known tokens',
      legendAria: '{title} distribution legend',
      emptyGroups: 'No grouped data yet',
      waiting: 'Waiting for the usage report',
      regionAria: '{title} usage detail, horizontally scrollable',
      caption: '{title} usage detail · exact values',
      tableRequests: 'Requests',
      tableTokens: 'Input / output',
      tableCache: 'Cache read',
      tableCost: 'Cost (USD)',
      emptyRange: 'No records in the selected range',
      errorsSuffix: '{count} errors',
      unknownUsageSuffix: 'usage unknown for {count}',
    },
    health: {
      title: 'Channel health',
      caption: 'Request results for the current filter; not a live connectivity check',
      tag: 'Local request observation',
      empty: 'No channel configuration or request history yet.',
      waiting: 'Waiting for the report',
      credentialReady: 'Credential configured · connectivity not checked',
      credentialNotReady: 'Credential not configured',
      historyOnly: 'Historical channel · not configured now',
      requests: 'Requests',
      errors: 'Errors',
      cancelled: 'Cancelled',
      balance: 'Account balance',
      manualEntry: 'Manually entered · {time} · not live',
      noBillingApi: 'No billing API is connected; the balance is not derived from local cost',
      quotaLabel: 'Manual quota · {unit}',
      quotaProgressAria: '{name} manual quota usage',
      recordedAt: 'Recorded at {time}',
      atLimit: ' · quota limit reached',
      resetsAt: ' · resets {time}',
      quotaMissing: 'Quota not provided',
      timeMissing: 'Time not provided',
      mockDemo: 'Offline demo · Mock',
    },
    daily: {
      summary: 'Daily usage detail',
      summaryNote: 'Exact values behind the trend and activity charts',
      regionAria: 'Daily usage detail, horizontally scrollable',
      caption: 'Per-day statistics of the same filter result',
      columnDate: 'Date',
      columnTokens: 'Tokens',
      columnCost: 'Cost (USD)',
      columnRequests: 'Requests',
      columnErrors: 'Errors / cancelled',
      columnSessions: 'Active sessions',
      emptyRange: 'No records in the selected range',
      waiting: 'Waiting for the usage report',
    },
    footnote: 'Statistics come from the same request report as the current query. Tokens are reported usage; input already includes cache. Cost is the known USD amount (possibly estimated from your configured prices) and is not an upstream bill. Balance and quota are separate manual snapshots.',
    aria: {
      kpiGrid: 'Usage overview, 10 metrics',
    },
    error: {
      dateRangeRequired: 'Choose a valid start and end date.',
      dateOrder: 'The start date cannot be later than the end date; adjust the range.',
    },
  },

  errors: {
    operationIncomplete: 'The operation did not complete: {status}',
    runtimeNotConnected: 'The local runtime is not connected. Try again shortly.',
    desktopBridgeMissing: 'Open the workbench from the LIWENCode desktop app; this page needs a secure local connection.',
    runtimeExited: 'The local runtime exited. Restart the app; saved sessions will be restored on startup.',
    noSession: 'Create or select a session first.',
    noWorkspace: 'Choose a workspace folder first.',
    actionInFlight: 'Another operation is already running. Try again shortly.',
    uploadIncomplete: 'The upload returned an incomplete result. Try again.',
    noCredentialChannel: 'The main process does not expose a credential channel, so the token will not be stored.',
    noCredentialChannelPlain: 'The main process does not expose a credential channel.',
    noSshCredentialChannel: 'The main process does not expose an SSH credential channel.',
    noProject: 'Add a project folder first.',
    sessionBusy: 'This session is still running; wait for it to finish or stop it.',
    newSessionTitle: 'New session',
  },
};

export function viewsMessages(lang: Lang): ViewsMessages {
  return lang === 'zh' ? zh : en;
}

/**
 * 未知键的左右标记（与 `i18n.ts` 一致）：`⟦path⟧`。
 *
 * 缺文案必须一眼看得出来，不能静默变成空串。
 */
const MISSING_OPEN = '⟦';
const MISSING_CLOSE = '⟧';

function lookup(messages: ViewsMessages, path: string): string | undefined {
  let node: unknown = messages;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * 按 `a.b.c` 取值 + `{name}` 插值；未知路径返回 `⟦path⟧`。
 *
 * 与 `i18n.ts` 的 `t()` 同语义，但**独立实现**：两个目录文件互不依赖内部函数，
 * 合并时只需搬命名空间，不需要先打通实现。
 */
export function tv(lang: Lang, path: string, vars?: Readonly<Record<string, string | number>>): string {
  const text = lookup(viewsMessages(lang), path);
  if (text === undefined) return `${MISSING_OPEN}${path}${MISSING_CLOSE}`;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

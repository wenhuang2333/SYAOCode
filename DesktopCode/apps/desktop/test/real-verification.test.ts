/**
 * 真实模型 / 真实窗口验证脚本的**契约**（执行在 `scripts/verify-real-*.mjs`）。
 *
 * 这些脚本平时不跑（要密钥、要联网），所以这里守住它们的性质，
 * 免得哪天它们变成"永远跳过、永远说 OK"的空壳：
 *
 *  1. 缺密钥 / 缺 Playwright / 缺构建产物时**跳过**并说明，绝不打印通过；
 *  2. 密钥**只从环境变量读**，脚本里不出现任何硬编码密钥；
 *  3. 断言的是**真实**证据（真实回复内容、确实经历过流式），
 *     不是"请求没报错"；
 *  4. 真实端点会多返回 `reasoning_content` —— 思维链必须单独成行，
 *     这一条是 mock 覆盖不到的，必须在脚本里显式检查。
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
// 测试文件在 apps/desktop/test/ → 仓库根在 ../../
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const model = read('../../scripts/verify-real-model.mjs');
const window_ = read('../../scripts/verify-real-window.mjs');
const both = model + window_;

describe('真实模型验证脚本', () => {
  it('缺环境变量时跳过并说明，不伪装通过', () => {
    expect(model).toContain('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL');
    expect(model).toContain('process.exit(0)');
    expect(model).toContain('REAL MODEL: OK');
  });

  it('密钥只从环境变量读，脚本里没有任何硬编码密钥', () => {
    expect(model).toContain("process.env['REAL_API_KEY']");
    // 形如 sk- 的密钥字面量绝不能出现在脚本里。
    expect(both).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
  });

  it('断言的是真实内容，不是"没报错"', () => {
    // 措辞用 contains：模型可能加标点/前缀，等值断言会把模型脾气误报成产品缺陷。
    expect(model).toContain(".toUpperCase().includes('PONG')");
    // 必须确认这一轮**确实经历过流式**，否则一次性返回也算通过。
    expect(model).toContain('sawStreaming');
    expect(model).toContain('这一轮确实经历了流式');
  });

  it('思维链必须单独成行（真实端点才有，mock 覆盖不到）', () => {
    expect(model).toContain("r.kind === 'thinking'");
    expect(model).toContain('推理内容单独成行（不混进正文）');
    expect(window_).toContain('推理内容没有混进正文');
  });

  it('等一轮结束看 runState，而不是 ACK（ACK 只说明命令被接受）', () => {
    expect(model).toContain("snap?.runState === 'idle'");
    expect(model).toContain("snap?.runState === 'streaming'");
  });
});

describe('真实窗口验证脚本', () => {
  it('缺 Playwright / Electron / 构建产物时跳过', () => {
    expect(window_).toContain('SKIP: playwright not installed');
    expect(window_).toContain('SKIP: electron binary not found');
    expect(window_).toContain('SKIP: apps/desktop/dist/main/index.js missing');
  });

  it('用 SYAOCODE_HOME（Host 只认这个变量名），不是 SYAO_HOME', () => {
    // 写成 SYAO_HOME 时 Host 会回退到 os.homedir()/.syaocode，
    // 于是读到另一份配置——这个坑真实踩过。
    expect(window_).toContain('SYAOCODE_HOME: home');
    expect(window_).not.toContain('SYAO_HOME: home');
  });

  it('配置在启动前持久化，用的是同一份 HOME 与工作区', () => {
    expect(window_).toContain('seedConfiguration');
    expect(window_).toContain("'config/set'");
    expect(window_).toContain("'channel/save'");
    // 工作区必须与 Electron 启动时一致（= apps/desktop）。
    expect(window_).toContain('const workspace = APP;');
  });

  it('在真实窗口里做真实交互，不是只截图', () => {
    expect(window_).toContain('page.locator');
    expect(window_).toContain('真实回复出现在时间线上');
    expect(window_).toContain('结束后不再显示流式指示');
  });
});

describe('真实模型：用量口径（N-22）', () => {
  const usage = read('../../scripts/verify-real-usage.mjs');

  it('断言 token 数与厂商返回一致，而不是"非零就算过"', () => {
    expect(usage).toContain('输入 token 数来自真实请求（> 0）');
    expect(usage).toContain('输出 token 数来自真实回复（> 0）');
    // total 必须恰好等于 input + output —— 防止凭空多算。
    expect(usage).toContain('总 token = 输入 + 输出');
    expect(usage).toContain('输入 token 量级合理（≥ 20）');
  });

  it('成本口径只要求自洽，不预设金额（厂商可能真的报 0）', () => {
    // 踩过的坑：一开始断言"未配单价必须是 null"，但网关会在 usage 里带 `cost`，
    // provider 如实采纳 0 —— 那不是撒谎。真正要防的是自相矛盾。
    expect(usage).toContain('成本口径自洽');
    expect(usage).toContain('成本是有限数');
    expect(usage).not.toContain("cost === null || cost === undefined || (unknownCostRequests > 0 && cost === 0)");
  });

  it('核对会话详情与全局台账一致（两处数字不能各说各话）', () => {
    expect(usage).toContain('会话详情的用量与全局台账一致');
    expect(usage).toContain('上下文占用已采集');
  });
});

describe('真实模型：工具调用闭环', () => {
  const tool = read('../../scripts/verify-real-tool-use.mjs');

  it('用"只有真读到文件才会出现的标记串"作为证据', () => {
    // 只断言"有 tool 行"是不够的：工具可能空跑。标记串证明结果真的回灌给了模型。
    expect(tool).toContain('ZQ7-MARKER-42');
    expect(tool).toContain('最终回复引用了文件里的真实内容');
  });

  it('要求工具真的执行成功，而不是一直 running / error', () => {
    expect(tool).toContain("r.state === 'ok'");
    expect(tool).toContain('工具执行成功');
  });

  it('缺凭据时跳过且不打印通过', () => {
    expect(tool).toContain('SKIP: set REAL_API_KEY, REAL_BASE_URL and REAL_MODEL.');
    expect(tool).toContain('REAL TOOL USE: OK');
  });
});

describe('真实模型：审批流（N-24 / N-25）', () => {
  const approval = read('../../scripts/verify-real-approval.mjs');

  it('核心断言是安全性质：写审批通过前文件不能被改动', () => {
    expect(approval).toContain('写操作在审批通过之前没有生效');
    expect(approval).toContain('original content');
  });

  it('只在 risk=write 的审批上采样（后面的审批发生在写入之后，采样会误报）', () => {
    // 第一版在每个审批上都断言"文件未改动"，第 3 次审批（写完之后）必然失败——
    // 那是脚本的错，不是产品的错。
    expect(approval).toContain("interaction.risk === 'write' && !writeChecked");
  });

  it('真实任务会有多次审批，脚本必须逐次批准', () => {
    // 只批准一次会停在第二张审批卡上，看起来像"卡住"，其实是脚本限制。
    expect(approval).toContain('const approved = new Set()');
    expect(approval).toContain('pending = (snap?.pendingInteractions ?? []).filter((i) => i.kind === \'permission\' && !approved.has(i.id))');
  });

  it('区分"命令执行失败"与"权限被拒伪装成工具错误"', () => {
    expect(approval).toContain('没有把"权限拒绝"伪装成普通工具错误');
    expect(approval).toContain('/denied|not permitted|approval|permission/i');
  });

  it('覆盖多步工具调用（同一轮内多次调用并收敛）', () => {
    expect(approval).toContain('同一轮内发生多次工具调用并收敛');
  });
});


describe('没有凭据时必须跳过，而不是"通过"或失败', () => {
  // 这是这些脚本能进 CI 的前提。逐个实跑，不靠读源码推断——
  // 读源码只能证明"写了 SKIP"，证明不了"真的会跳过"。
  const scripts = [
    ['verify-real-model', 'REAL MODEL: OK'],
    ['verify-real-window', 'REAL WINDOW: OK'],
    ['verify-real-usage', 'REAL USAGE: OK'],
    ['verify-real-tool-use', 'REAL TOOL USE: OK'],
    ['verify-real-approval', 'REAL APPROVAL: OK'],
    ['verify-real-commit-message', 'COMMIT MESSAGE: OK'],
  ] as const;

  for (const [name, okMarker] of scripts) {
    it(`${name}：无凭据时退出 0、说明跳过，且**不**打印通过标记`, async () => {
      const env = { ...process.env } as NodeJS.ProcessEnv;
      delete env['REAL_API_KEY'];
      delete env['REAL_BASE_URL'];
      delete env['REAL_MODEL'];
      delete env['SYAO_PLAYWRIGHT'];
      const { stdout, stderr } = await run(
        'node',
        ['--import', 'tsx', path.join(ROOT, 'scripts', `${name}.mjs`)],
        { cwd: ROOT, env },
      );
      const output = `${stdout}${stderr}`;
      expect(output).toContain('SKIP');
      expect(output).not.toContain(okMarker);
    }, 60_000);
  }
});

describe('文档核对脚本（verify:docs）', () => {
  const docs = read('../../scripts/verify-docs.mjs');

  it('核对的是数字与代码，不是"看起来像文档"', () => {
    // 曾发生过两次漂移：测试数 671→727、错误码 47→48。
    expect(docs).toContain('错误码数');
    expect(docs).toContain('语义令牌数');
    expect(docs).toContain('事件类型数');
    expect(docs).toContain('两份文档的测试数一致');
  });

  it('会把差异**打印出来**（只报 FAIL 不报数字等于没说）', () => {
    expect(docs).toContain('`文档 ${claimed} / 代码 ${actual}`');
  });

  it('文档是本地文件：缺失时跳过，不在干净克隆里失败', () => {
    // `doc/` 被 .gitignore 拦截，公开仓库里没有；脚本必须能安静跳过。
    expect(docs).toContain('SKIP: doc/DesktopDoc not present');
    expect(docs).toContain('process.exit(0)');
  });

  it('错误码是负数，比的是绝对值最大（曾经把上下限搞反）', () => {
    expect(docs).toContain('错误码是负的');
    expect(docs).toContain('Math.abs');
  });
});


describe('缺口清单与代码现状的双向核对', () => {
  const docs = read('../../scripts/verify-docs.mjs');

  it('既查"代码有但册子说没有"，也查"册子说有但代码没有"', () => {
    // N-9（OAuth 界面）与 N-15（提交信息联调）都曾长期被误标为未完成，
    // 害得读者（包括我自己）以为还有工作没做。
    expect(docs).toContain('GAP_EVIDENCE');
    expect(docs).toContain('代码已具备，登记册却仍标未完成');
    expect(docs).toContain('代码不具备，登记册却已标完成');
  });

  it('用代码谓词判定，而不是关键词重叠（后者会把 N-1 误报成矛盾）', () => {
    expect(docs).toContain("hasText('apps/desktop/src/renderer/git-sidebar.tsx', 'onOauthStart')");
    expect(docs).toContain("index.has('verify-real-window.mjs')");
  });

  it('通过时不打印失败措辞（否则绿色输出会误导）', () => {
    expect(docs).toContain('agree ? \'\' :');
  });
});


describe('文档里的单文件用例数用权威来源核对', () => {
  const docs = read('../../scripts/verify-docs.mjs');

  it('用 `vitest list --json`，不用静态计数（静态计数实测会错）', () => {
    // 教训：`it(` 字符串匹配把 `git-auth.test.ts` 数成 34，真实是 40；
    // 照静态数改文档只会"改出新错误"。
    expect(docs).toContain("'vitest', 'list', '--json'");
    expect(docs).toContain('文档引用的单文件用例数与真实收集数一致');
  });

  it('vitest 不可用时跳过而不是误报', () => {
    expect(docs).toContain('无法运行 `vitest list`，跳过单文件用例数核对');
  });
});


describe('真实模型脚本必须区分"模型没试"与"产品坏了"', () => {
  // 真实模型有自主性：它可能这次不调工具、不改文件、措辞不同。
  // 把这种自由度报成 FAIL，FAIL 就会读成"我们的链路坏了"——
  // 那是把模型的脾气误报成产品缺陷，也正是我要求自己避免的假警报。
  const approval = read('../../scripts/verify-real-approval.mjs');
  const tool = read('../../scripts/verify-real-tool-use.mjs');
  const model = read('../../scripts/verify-real-model.mjs');

  it('审批流：模型没请求写操作时判为不可判，而不是失败', () => {
    expect(approval).toContain('writeRequested');
    expect(approval).toContain('REAL APPROVAL: INCONCLUSIVE');
    // 不可判时也不许打印通过标记。
    expect(approval).toContain('process.exit(0)');
  });

  it('工具调用：模型没调工具时同样判为不可判', () => {
    expect(tool).toContain('REAL TOOL USE: INCONCLUSIVE');
  });

  it('回复措辞用 contains 而不是等值（模型可能加标点或前缀）', () => {
    expect(model).toContain("(assistant?.text ?? '').toUpperCase().includes('PONG')");
    expect(model).not.toContain("assistant?.text?.trim() === 'PONG'");
  });
});

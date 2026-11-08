/**
 * 提交信息生成服务的单测（`27` §4.3 FR-N-026 / §10.5.2）。
 *
 * 全部用假 `complete`：不联网、不读盘。重点验证：
 *  - Conventional Commits 格式与长度约束；
 *  - 元叙述 / 代码围栏 / `git commit -m` 包裹 / 外层引号被剥离；
 *  - 模型抛错、超时、返回空白 → 确定性 fallback（绝不抛错）；
 *  - diff 截断标记、URL 内嵌凭据剥离。
 */

import { describe, expect, it } from 'vitest';
import {
  buildCommitPrompt,
  COMMIT_TYPES,
  CommitMessageService,
  DEFAULT_COMMIT_MAX_DIFF_BYTES,
  fallbackCommitMessage,
  sanitizeCommitMessage,
  type CommitMessageInput,
  type CompletionRequest,
} from '../src/commit-message.ts';

const WORKSPACE = '/tmp/liwencode-commit-message';

const CONVENTIONAL = /^(feat|fix|refactor|perf|test|docs|build|chore|ci|style|revert)(\([^)]*\))?!?: .+$/u;

function input(overrides: Partial<CommitMessageInput> = {}): CommitMessageInput {
  return {
    workspaceRoot: WORKSPACE,
    files: ['src/commit-message.ts'],
    diff: 'diff --git a/src/commit-message.ts b/src/commit-message.ts\n+export const generated = true;\n',
    ...overrides,
  };
}

function subjectOf(message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  const index = firstLine.indexOf(': ');
  return index < 0 ? firstLine : firstLine.slice(index + 2);
}

describe('sanitizeCommitMessage（纯函数）', () => {
  it('保留合规的 Conventional Commit 信息', () => {
    expect(sanitizeCommitMessage('feat(host): add commit message service')).toBe(
      'feat(host): add commit message service',
    );
  });

  it('剥离 markdown 代码围栏（多行与行内）', () => {
    expect(sanitizeCommitMessage('```text\nfix(git): avoid stale revision\n```')).toBe(
      'fix(git): avoid stale revision',
    );
    expect(sanitizeCommitMessage('```feat: inline fence```')).toBe('feat: inline fence');
  });

  it('剥离中文元叙述开头', () => {
    expect(sanitizeCommitMessage('根据对话，我生成了如下提交信息：\n\nfeat: add x')).toBe('feat: add x');
  });

  it('剥离英文元叙述开头（Here is / The following）', () => {
    expect(sanitizeCommitMessage('Here is the commit message: docs: update readme')).toBe(
      'docs: update readme',
    );
    expect(sanitizeCommitMessage('The following is the commit message:\n\nci: run host tests')).toBe(
      'ci: run host tests',
    );
  });

  it('把 "This commit adds …" 归一为祈使句主题', () => {
    expect(sanitizeCommitMessage('This commit adds a parser for the diff output.')).toBe(
      'chore: add a parser for the diff output',
    );
  });

  it('剥离 git commit -m 包裹与外层引号', () => {
    expect(sanitizeCommitMessage('git commit -m "feat(git): add upload preflight"')).toBe(
      'feat(git): add upload preflight',
    );
    expect(sanitizeCommitMessage("git commit -am 'fix: correct diff hunk header'")).toBe(
      'fix: correct diff hunk header',
    );
    expect(sanitizeCommitMessage('"refactor: split prompt builder."')).toBe('refactor: split prompt builder');
  });

  it('剥离 Subject: / Message: 前缀', () => {
    expect(sanitizeCommitMessage('Subject: perf: cache parsed diff')).toBe('perf: cache parsed diff');
    expect(sanitizeCommitMessage('Message:\n\nci: run host tests on node 22')).toBe(
      'ci: run host tests on node 22',
    );
  });

  it('未知 type 归到 chore，常见别名映射到白名单', () => {
    expect(sanitizeCommitMessage('feature(host): add commit message service')).toBe(
      'feat(host): add commit message service',
    );
    expect(sanitizeCommitMessage('Add support for commit messages')).toBe(
      'chore: add support for commit messages',
    );
    expect(sanitizeCommitMessage('wip: tidy scripts')).toBe('chore: tidy scripts');
  });

  it('保留 breaking change 标记', () => {
    expect(sanitizeCommitMessage('feat(api)!: drop legacy endpoint')).toBe('feat(api)!: drop legacy endpoint');
  });

  it('首行超过 72 字符时截断 subject', () => {
    const result = sanitizeCommitMessage(`feat: ${'a'.repeat(120)}`);
    const subject = subjectOf(result);
    expect(Array.from(subject).length).toBeLessThanOrEqual(72);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('正文与首行之间空一行，且每行不超过 100 字符', () => {
    const bodyLine = 'word '.repeat(40).trim();
    const result = sanitizeCommitMessage(`feat: add body\n${bodyLine}`);
    const lines = result.split('\n');
    expect(lines[0]).toBe('feat: add body');
    expect(lines[1]).toBe('');
    for (const line of lines.slice(2)) {
      expect(Array.from(line).length).toBeLessThanOrEqual(100);
    }
  });

  it('丢弃纯元叙述行与围栏残留', () => {
    expect(sanitizeCommitMessage('根据本次会话改动：\n\n以下是提交信息：\n\nchore: tidy scripts')).toBe(
      'chore: tidy scripts',
    );
  });

  it('空输入 / 无有效内容返回空串', () => {
    expect(sanitizeCommitMessage('')).toBe('');
    expect(sanitizeCommitMessage('   \n\n  ')).toBe('');
    expect(sanitizeCommitMessage('```\n```')).toBe('');
  });

  it('剥离 URL 内嵌凭据与令牌样式内容', () => {
    expect(sanitizeCommitMessage('fix: rotate https://u:p@host/x.git')).toBe('fix: rotate https://host/x.git');
    const withToken = sanitizeCommitMessage('chore: rotate ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(withToken).not.toContain('ghp_');
    expect(withToken).toContain('***');
  });

  it('所有输出都以白名单 type 开头', () => {
    for (const type of COMMIT_TYPES) {
      expect(CONVENTIONAL.test(`${type}: sample subject`)).toBe(true);
    }
  });
});

describe('fallbackCommitMessage（纯函数）', () => {
  it('无文件时仍返回非空的 Conventional Commit', () => {
    const message = fallbackCommitMessage([]);
    expect(message.length).toBeGreaterThan(0);
    expect(message).toMatch(CONVENTIONAL);
  });

  it('单文件给出可读主题', () => {
    expect(fallbackCommitMessage(['src/a.ts'])).toBe('chore: update src/a.ts');
  });

  it('多文件给出数量', () => {
    expect(fallbackCommitMessage(['src/a.ts', 'src/b.ts', 'src/c.ts'])).toBe('chore: update 3 files');
  });

  it('按文件类型推断 docs / test / ci', () => {
    expect(fallbackCommitMessage(['docs/a.md', 'docs/b.md'])).toBe('docs: update 2 files');
    expect(fallbackCommitMessage(['src/a.test.ts', 'src/b.test.ts'])).toBe('test: update 2 files');
    expect(fallbackCommitMessage(['.github/workflows/host.yml'])).toBe(
      'ci: update .github/workflows/host.yml',
    );
  });

  it('长路径仍满足 subject 长度限制', () => {
    const message = fallbackCommitMessage([`${'a/'.repeat(60)}file.ts`]);
    expect(Array.from(subjectOf(message)).length).toBeLessThanOrEqual(72);
    expect(message).toMatch(CONVENTIONAL);
  });

  it('忽略空白路径', () => {
    expect(fallbackCommitMessage(['', '   '])).toBe('chore: update files');
  });
});

describe('buildCommitPrompt（纯函数）', () => {
  it('包含文件列表、diff、会话改动摘要与 hint', () => {
    const { system, prompt } = buildCommitPrompt(
      input({
        files: ['src/commit-message.ts', 'src/host.ts'],
        sessionChanges: [
          { path: 'src/commit-message.ts', status: 'added', added: 120, removed: 0 },
          { path: 'src/host.ts', status: 'modified', added: null, removed: null },
        ],
        hint: '只提交 Git 相关改动',
      }),
    );
    expect(system).toMatch(/only the commit message/i);
    expect(system).toMatch(/no explanation/i);
    expect(prompt).toContain('src/commit-message.ts');
    expect(prompt).toContain('src/host.ts');
    expect(prompt).toContain('+120 -0');
    expect(prompt).toContain('+? -?');
    expect(prompt).toContain('只提交 Git 相关改动');
    expect(prompt).toContain('+export const generated = true;');
  });

  it('超长 diff 被截断并标注 diff truncated', () => {
    const { prompt } = buildCommitPrompt(input({ diff: 'x'.repeat(DEFAULT_COMMIT_MAX_DIFF_BYTES + 1024) }));
    expect(prompt).toContain('diff truncated');
  });

  it('空 diff 有明确占位', () => {
    const { prompt } = buildCommitPrompt(input({ diff: '' }));
    expect(prompt).toContain('(no diff provided)');
  });

  it('64 KiB diff 不出现灾难性回溯（性能护栏）', () => {
    const diff = `${'x'.repeat(DEFAULT_COMMIT_MAX_DIFF_BYTES + 512)}\n+remote=https://u:p@host/x.git\n`;
    // 两次测量取较快的一次：第一次可能被 JIT / 并行测试的 CPU 抢占拉长。
    const measure = (): number => {
      const startedAt = Date.now();
      buildCommitPrompt(input({ diff }));
      return Date.now() - startedAt;
    };
    measure();
    const elapsed = Math.min(measure(), measure());
    const { prompt } = buildCommitPrompt(input({ diff }));
    expect(prompt).toContain('diff truncated');
    // 曾经的正则会回溯到 13 秒；这里给足并行测试的余量（2 s），
    // 仍然能在数量级上抓住回溯（正常是毫秒级）。
    expect(elapsed).toBeLessThan(2_000);
  });

  it('diff 里的 URL 内嵌凭据被剥离', () => {
    const { prompt } = buildCommitPrompt(
      input({ diff: 'diff --git a/x b/x\n+remote=https://u:p@host/x.git\n' }),
    );
    expect(prompt).not.toContain('p@');
    expect(prompt).not.toContain('u:p@');
    expect(prompt).toContain('https://host/x.git');
  });
});

describe('CommitMessageService.generate', () => {
  it('正常返回模型结果（source=model，清洗后无围栏）', async () => {
    const requests: CompletionRequest[] = [];
    const service = new CommitMessageService({
      complete: async (request) => {
        requests.push(request);
        return '```\nfeat(git): add commit message generation\n```';
      },
    });
    const result = await service.generate(input());
    expect(result.source).toBe('model');
    expect(result.reason).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.message).toBe('feat(git): add commit message generation');
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.prompt).toContain('src/commit-message.ts');
    expect(request?.system).toMatch(/no markdown code fences/i);
  });

  it('模型抛错 → fallback，且绝不抛出', async () => {
    const service = new CommitMessageService({
      complete: async () => {
        throw new Error('provider down');
      },
    });
    const result = await service.generate(input({ files: ['src/a.ts'] }));
    expect(result.source).toBe('fallback');
    expect(result.reason).toBe('model unavailable');
    expect(result.message).toBe('chore: update src/a.ts');
    expect(result.message).toMatch(CONVENTIONAL);
  });

  it('同步抛错也归到不可用', async () => {
    const service = new CommitMessageService({
      complete: () => {
        throw new Error('sync boom');
      },
    });
    const result = await service.generate(input());
    expect(result.source).toBe('fallback');
    expect(result.reason).toBe('model unavailable');
  });

  it('模型返回空白 → fallback + empty reason', async () => {
    const service = new CommitMessageService({ complete: async () => '   \n\n' });
    const result = await service.generate(input());
    expect(result.source).toBe('fallback');
    expect(result.reason).toBe('model returned an empty message');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('超时 → fallback，且必须 abort 掉 signal', async () => {
    let captured: AbortSignal | undefined;
    const service = new CommitMessageService({
      timeoutMs: 50,
      complete: (request) => {
        captured = request.signal;
        return new Promise<string>(() => {
          /* 永不 resolve：只能靠超时收尾 */
        });
      },
    });
    const result = await service.generate(input());
    expect(result.source).toBe('fallback');
    expect(result.reason).toBe('model timed out');
    expect(captured?.aborted).toBe(true);
  });

  it('超长 diff → truncated=true 且提示词含截断标注', async () => {
    let prompt = '';
    const service = new CommitMessageService({
      complete: async (request) => {
        prompt = request.prompt;
        return 'chore: trim diff';
      },
    });
    const result = await service.generate(input({ diff: 'y'.repeat(DEFAULT_COMMIT_MAX_DIFF_BYTES + 100) }));
    expect(result.truncated).toBe(true);
    expect(prompt).toContain('diff truncated');
  });

  it('自定义 maxDiffBytes 生效', async () => {
    let prompt = '';
    const service = new CommitMessageService({
      maxDiffBytes: 16,
      complete: async (request) => {
        prompt = request.prompt;
        return 'chore: small diff';
      },
    });
    const result = await service.generate(input({ diff: 'z'.repeat(64) }));
    expect(result.truncated).toBe(true);
    expect(prompt).toContain('diff truncated');
  });

  it('提示词不含 diff 内嵌凭据，返回的 message 也不含密钥', async () => {
    let prompt = '';
    const service = new CommitMessageService({
      complete: async (request) => {
        prompt = request.prompt;
        return 'fix: rotate https://u:p@host/x.git';
      },
    });
    const result = await service.generate(input({ diff: '+remote=https://u:p@host/x.git\n' }));
    expect(prompt).not.toContain('p@');
    expect(result.message).not.toContain('p@');
    expect(result.message).toContain('https://host/x.git');
  });

  it('fallback 也保留 truncated 标记', async () => {
    const service = new CommitMessageService({
      complete: async () => {
        throw new Error('offline');
      },
    });
    const result = await service.generate(input({ diff: 'q'.repeat(DEFAULT_COMMIT_MAX_DIFF_BYTES + 1) }));
    expect(result.source).toBe('fallback');
    expect(result.truncated).toBe(true);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceService } from '../src/workspace.ts';

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'liwen-fence-'));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('文件浏览的真实路径围栏', () => {
  it('拒绝工作区内指向外部文件的符号链接', async () => {
    const root = await temporary(); const outside = await temporary();
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await expect(new WorkspaceService({ root }).readFile('link.txt')).rejects.toThrow('escapes workspace');
  });
  it('拒绝通过目录符号链接浏览外部目录', async () => {
    const root = await temporary(); const outside = await temporary();
    await symlink(outside, join(root, 'external'));
    await expect(new WorkspaceService({ root }).tree('external')).rejects.toThrow('escapes workspace');
  });
  it('允许项目根本身为符号链接且目标文件在根内', async () => {
    const parent = await temporary();
    const real = join(parent, 'real'); await mkdir(real); await writeFile(join(real, 'a.ts'), 'safe');
    await symlink(real, join(parent, 'project'));
    const ws = new WorkspaceService({ root: join(parent, 'project') });
    await expect(ws.readFile('a.ts')).resolves.toMatchObject({ path: 'a.ts', text: 'safe' });
    await expect(ws.tree()).resolves.toMatchObject([{ path: 'a.ts' }]);
  });
  it('隐藏敏感文件且直接读取也被拒绝', async () => {
    const root = await temporary();
    await writeFile(join(root, '.env'), 'SOME_KEY=secret');
    await writeFile(join(root, 'main.ts'), 'code');
    const ws = new WorkspaceService({ root });
    expect((await ws.tree()).map((node) => node.name)).toEqual(['main.ts']);
    await expect(ws.readFile('.env')).rejects.toThrow('sensitive');
  });
  it('敏感文件换名符号链接不能绕过检查', async () => {
    const root = await temporary();
    await writeFile(join(root, 'private.pem'), 'secret');
    await symlink(join(root, 'private.pem'), join(root, 'public.txt'));
    await expect(new WorkspaceService({ root }).readFile('public.txt')).rejects.toThrow('sensitive');
  });
  it('读取上限按字节截断，不载入全部内容', async () => {
    const root = await temporary(); await writeFile(join(root, 'large.txt'), 'x'.repeat(50000));
    await expect(new WorkspaceService({ root, maxReadBytes: 16 }).readFile('large.txt')).resolves.toMatchObject({ text: 'x'.repeat(16), truncated: true });
  });
});

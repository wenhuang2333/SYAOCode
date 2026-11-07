import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { Markdown, safeLink } from '../../../packages/ui/src/markdown.tsx';

describe('安全 Markdown', () => {
  it('拒绝脚本、文件、自定义 scheme 和带凭据链接', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'https://user:password@example.test/path']) expect(safeLink(url)).toBeUndefined();
    expect(safeLink('https://example.test/path')).toBe('https://example.test/path');
  });
  it('转义原始 HTML 而不执行', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '<script>alert(1)</script>\n<img src=x onerror=alert(1)>' }));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });
  it('呈现标题、代码、列表和表格', () => {
    const text = '# 标题\n\n- **项目**\n- `code`\n\n```ts\nconst a = 1;\n```\n\n| 列 | 值 |\n| --- | --- |\n| A | 1 |';
    const html = renderToStaticMarkup(createElement(Markdown, { text }));
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>项目</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('const a = 1;');
  });
  it('不完整代码块在流式输出期间可显示', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '```ts\nconst a =' }));
    expect(html).toContain('const a =');
  });
});

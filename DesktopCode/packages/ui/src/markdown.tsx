import { createElement, useState, type ReactNode } from 'react';

export function safeLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) return parsed.href;
  } catch { return undefined; }
  return undefined;
}

function inline(text: string): ReactNode[] {
  const pieces: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    if (start > position) pieces.push(text.slice(position, start));
    const raw = match[0];
    if (raw.startsWith('`')) pieces.push(<code key={start}>{raw.slice(1, -1)}</code>);
    else if (raw.startsWith('**')) pieces.push(<strong key={start}>{raw.slice(2, -2)}</strong>);
    else {
      const separator = raw.indexOf('](');
      const title = raw.slice(1, separator);
      const url = safeLink(raw.slice(separator + 2, -1));
      pieces.push(url ? <a key={start} href={url} target="_blank" rel="noopener noreferrer">{title}</a> : title);
    }
    position = start + raw.length;
  }
  if (position < text.length) pieces.push(text.slice(position));
  return pieces;
}

function CodeBlock({ text, language }: { text: string; language: string }) {
  const [status, setStatus] = useState('复制');
  return <pre><div className="code-heading"><span>{language || 'text'}</span><button type="button" onClick={() => {
    void navigator.clipboard.writeText(text).then(() => setStatus('已复制')).catch(() => setStatus('复制失败'));
  }}>{status}</button></div><code>{text}</code></pre>;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
const isTableRule = (line: string) => line.includes('|') && cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = i;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push(<CodeBlock key={key} text={code.join('\n')} language={language} />);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { blocks.push(createElement(`h${heading[1]!.length}`, { key }, inline(heading[2]!))); i++; continue; }
    if (i + 1 < lines.length && line.includes('|') && isTableRule(lines[i + 1]!)) {
      const headers = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      blocks.push(<div className="markdown-table" key={key}><table><thead><tr>{headers.map((cell, n) => <th key={n}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{headers.map((_, j) => <td key={j}>{inline(row[j] ?? '')}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[] = [];
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length && pattern.test(lines[i]!)) items.push(<li key={i}>{inline(lines[i++]!.replace(pattern, ''))}</li>);
      blocks.push(createElement(ordered ? 'ol' : 'ul', { key }, items));
      continue;
    }
    if (line.startsWith('> ')) { blocks.push(<blockquote key={key}>{inline(line.slice(2))}</blockquote>); i++; continue; }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^(?:#{1,4}\s|```|>\s|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!) && !(i + 1 < lines.length && isTableRule(lines[i + 1]!))) paragraph.push(lines[i++]!);
    blocks.push(<p key={key}>{inline(paragraph.join('\n'))}</p>);
  }
  return <div className="markdown-block">{blocks}</div>;
}

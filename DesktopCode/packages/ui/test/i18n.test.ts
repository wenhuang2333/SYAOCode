import { describe, expect, it } from 'vitest';
import { messages, t, type Messages } from '../src/i18n.ts';

describe('i18n', () => {
  it('en 与 zh 的键集合完全相同', () => {
    const zhKeys = Object.keys(messages('zh')).sort();
    const enKeys = Object.keys(messages('en')).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('每个键在中英两边都非空', () => {
    for (const key of Object.keys(messages('zh')) as (keyof Messages)[]) {
      expect(t('zh', key)).not.toBe('');
      expect(t('en', key)).not.toBe('');
    }
  });

  it('未知键显式可见（不静默返回空串）', () => {
    // @ts-expect-error 故意传非法键
    expect(t('zh', 'noSuchKey')).toBe('⟦noSuchKey⟧');
  });

  it('语言切换返回不同文案', () => {
    expect(t('zh', 'send')).not.toBe(t('en', 'send'));
  });
});

/**
 * 主题（FR-N-037 / doc 27 §11.4）。
 *
 * 三档：`system` 跟随系统、`light`、`dark`。默认 `system`——用户没表态时
 * 跟随操作系统的偏好是最不容易出错的选择。
 *
 * 为什么用 `data-theme` 而不是 class：令牌层用 `[data-theme='dark']`
 * 选择器覆盖语义色，属性比 class 更明确，也便于 CSS 断言。
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'syao:theme';

export const THEME_OPTIONS: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/** 从任意输入解析偏好；无法识别时退回 `system`（不抛错，存储可能被清空）。 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** 把偏好解析成实际生效的主题。 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * 把主题写到 `<html>` 上。
 *
 * `dataset.theme` 只在**深色**时设置；浅色时删除属性，让 `:root` 的默认值生效。
 * 这样"浅色"永远等于"没有任何覆盖"，减少一类难查的样式泄漏。
 */
export function applyTheme(theme: ResolvedTheme, root: { dataset: { theme?: string }; style: { colorScheme: string } }): void {
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  // 让原生控件（滚动条、表单）也跟着主题走。
  root.style.colorScheme = theme;
}

/** 系统是否偏好深色。无 `matchMedia` 时按浅色处理。 */
export function systemPrefersDark(matchMedia: ((query: string) => { matches: boolean }) | undefined): boolean {
  return matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** 读存储里的偏好；存储不可用（隐私模式 / 配额）时退回默认。 */
export function readStoredTheme(storage: { getItem(key: string): string | null } | undefined): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** 写存储；失败静默（主题是偏好而非数据，不该因存储失败阻塞界面）。 */
export function storeTheme(storage: { setItem(key: string, value: string): void } | undefined, preference: ThemePreference): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* 忽略 */
  }
}

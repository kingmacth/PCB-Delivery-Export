/**
 * i18n.ts —— 多语言文本读取封装
 *
 * `eda.sys_I18n.text(tag, namespace?, language?, ...args)`
 * 文本来源：扩展包内 `/locales/<language>.json`。
 * 语言优先级（官方）：当前显示语言 > 系统默认语言 > 首个命中该 tag 的语言 > tag 自身。
 */

/**
 * 取多语言文本。
 *
 * 三重兜底，保证 UI **永远不会出现空白或 "undefined"**：
 *   1. 官方 `sys_I18n.text` 抛错   → 回退 tag
 *   2. 官方返回空串               → 回退 tag
 *   3. 官方返回 `undefined`（多语言文件缺失时的常见表现）→ 回退 tag
 *
 * 由于本扩展的 tag 本身就是中文原文，回退后界面依然是可读的。
 */
export function t(tag: string, ...args: Array<unknown>): string {
	try {
		const text = eda.sys_I18n.text(tag, undefined, undefined, ...args);
		if (typeof text === 'string' && text.length > 0)
			return text;
	}
	catch {
		/* 落到下面的兜底 */
	}
	return tag;
}

/**
 * 带参数的多语言文本；对 `undefined` / `null` 参数做安全替换，避免出现 "undefined" 字样。
 */
export function tf(tag: string, ...args: Array<string | number>): string {
	const safeArgs = args.map(a => (a === undefined || a === null ? '' : a));
	return t(tag, ...safeArgs);
}

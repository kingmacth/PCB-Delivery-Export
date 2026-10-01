/**
 * designators.ts —— BOM / CPL 位号解析
 *
 * 需求（对应任务书第十一节）：
 * BOM 中的 Designator 单元格**不能**简单按字符串比较，因为 EasyEDA 会把同一料号的多个位号
 * 合并进一个单元格，出现过多种写法：
 *
 *   "R1,R2,R3"        → R1 R2 R3
 *   "R1, R2, R3"      → R1 R2 R3
 *   "R1 R2 R3"        → R1 R2 R3
 *   "R1\nR2"          → R1 R2
 *   "R1、R2"          → R1 R2
 *   "R1-R5"           → R1 R2 R3 R4 R5   （区间展开）
 *   "R1-5"            → R1 R2 R3 R4 R5   （区间展开，上界省略前缀）
 *
 * 实现为「先按分隔符切分，再对每个片段尝试区间展开」，最终产出**大小写无关**的位号集合，
 * 同时保留原始写法用于报告展示。
 */

/** 分隔符：半角/全角逗号、分号、顿号、竖线、空白（含换行与制表符） */
const SPLIT_REGEX = /[,;，；、|\s]+/u;

/** 区间展开的合理上限，避免 "R1-R999999" 之类的异常输入把内存吃满 */
const MAX_RANGE_SPAN = 1000;

/** 解析结果 */
export interface DesignatorParseResult {
	/** 规范化（大写）后的位号集合，用于集合运算 */
	set: Set<string>;
	/** 原始写法集合（去重，保持首次出现顺序），用于展示 */
	originals: string[];
	/** 被展开的区间片段，用于诊断 */
	expandedRanges: string[];
}

/**
 * 位号规范化：大写 + 去首尾空格。
 * 之所以统一大写：EasyEDA 中位号可能因输入习惯出现小写，比较时不应区分大小写。
 */
export function normalizeDesignator(value: string): string {
	return value.trim().toUpperCase();
}

/**
 * 尝试把一个片段当作区间展开。
 * 支持 `PREFIX数字-PREFIX数字` 与 `PREFIX数字-数字`；前缀必须一致。
 * 不满足区间特征时返回 `undefined`，调用方按普通位号处理。
 */
function tryExpandRange(token: string): string[] | undefined {
	// 形如 R1-R5 / R1-5 / C10-C12
	const match = /^([A-Za-z_#]+)(\d+)\s*[-–~]\s*([A-Za-z_#]*)(\d+)$/u.exec(token);
	if (!match)
		return undefined;

	const [, prefixLower, startText, endPrefixRaw, endText] = match;
	const endPrefix = endPrefixRaw === '' ? prefixLower : endPrefixRaw;
	if (prefixLower.toUpperCase() !== endPrefix.toUpperCase())
		return undefined;

	const start = Number.parseInt(startText, 10);
	const end = Number.parseInt(endText, 10);
	if (!Number.isFinite(start) || !Number.isFinite(end))
		return undefined;
	if (end < start)
		return undefined;
	// 过大的跨度不是真区间，按普通位号处理
	if (end - start > MAX_RANGE_SPAN)
		return undefined;

	// 数字补齐位数：R01-R05 应展开为 R01..R05 而不是 R1..R5
	const width = Math.max(startText.length, endText.length);
	const prefix = prefixLower.toUpperCase();

	const out: string[] = [];
	for (let n = start; n <= end; n++)
		out.push(`${prefix}${String(n).padStart(width, '0')}`);

	return out;
}

/**
 * 把一段（可能含多个位号）的文本解析为位号集合。
 *
 * @param raw 原始文本，例如 "R1, R2, R3" 或 "C1-C3"
 */
export function parseDesignators(raw: string | undefined | null): DesignatorParseResult {
	const set = new Set<string>();
	const originals: string[] = [];
	const expandedRanges: string[] = [];

	if (raw === undefined || raw === null)
		return { set, originals, expandedRanges };

	const text = String(raw);
	if (text.trim() === '')
		return { set, originals, expandedRanges };

	for (const rawToken of text.split(SPLIT_REGEX)) {
		const token = rawToken.trim();
		if (token === '')
			continue;

		const expanded = tryExpandRange(token);
		if (expanded) {
			expandedRanges.push(token);
			for (const item of expanded) {
				if (!set.has(item)) {
					set.add(item);
					originals.push(item);
				}
			}
			continue;
		}

		const normalized = normalizeDesignator(token);
		if (normalized === '')
			continue;
		if (!set.has(normalized)) {
			set.add(normalized);
			originals.push(token);
		}
	}

	return { set, originals, expandedRanges };
}

/** 把一批位号文本合并为一个集合（BOM 同一料号可能跨多行）。 */
export function mergeDesignators(rawList: Array<string | undefined | null>): DesignatorParseResult {
	const merged: DesignatorParseResult = { set: new Set<string>(), originals: [], expandedRanges: [] };

	for (const raw of rawList) {
		const parsed = parseDesignators(raw);
		for (const d of parsed.set) {
			if (!merged.set.has(d)) {
				merged.set.add(d);
				// 保留原写法：从 parsed.originals 中找对应项
				const idx = parsed.originals.findIndex(o => normalizeDesignator(o) === d);
				merged.originals.push(idx >= 0 ? parsed.originals[idx] : d);
			}
		}
		for (const r of parsed.expandedRanges) {
			if (!merged.expandedRanges.includes(r))
				merged.expandedRanges.push(r);
		}
	}

	return merged;
}

/**
 * 计算「在 A 中但不在 B 中」的位号，结果按原写法输出并按自然顺序排序。
 */
export function difference(a: DesignatorParseResult, b: DesignatorParseResult): string[] {
	const result: string[] = [];
	for (let i = 0; i < a.originals.length; i++) {
		const original = a.originals[i];
		const key = normalizeDesignator(original);
		if (!a.set.has(key))
			continue;
		if (b.set.has(key))
			continue;
		if (!result.some(r => normalizeDesignator(r) === key))
			result.push(original);
	}
	return sortDesignators(result);
}

/** 自然排序：先按字母前缀，再按数字大小（R2 排在 R10 前面）。 */
export function sortDesignators(list: string[]): string[] {
	return [...list].sort((x, y) => {
		const mx = /^([A-Za-z_#]+)(\d+)/u.exec(x);
		const my = /^([A-Za-z_#]+)(\d+)/u.exec(y);
		if (mx && my) {
			const px = mx[1].toUpperCase();
			const py = my[1].toUpperCase();
			if (px !== py)
				return px < py ? -1 : 1;
			const nx = Number.parseInt(mx[2], 10);
			const ny = Number.parseInt(my[2], 10);
			if (nx !== ny)
				return nx - ny;
			return x.localeCompare(y);
		}
		return x.localeCompare(y);
	});
}

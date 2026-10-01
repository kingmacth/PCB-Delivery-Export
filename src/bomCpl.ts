/**
 * bomCpl.ts —— BOM / CPL 的解析、比对与过滤
 *
 * 流程（对应任务书第十、十一、十二、十三节）：
 *   1. 解析已导出的 BOM  → 收集全部 Designator 组成集合
 *   2. 解析已导出的 CPL  → 逐行取 Designator
 *   3. CPL 行中的位号若**完全不存在**于 BOM 集合 → 标记该行待删除
 *   4. 从 CPL 文件中删除这些行并另存（**保持 XLSX 格式**）
 *   5. 反向检查：BOM 有而 CPL 没有的位号 → 仅告警，**绝不自动添加**
 *
 * 以「行内所有位号都不在 BOM 中」作为删除条件：
 * 常规 CPL 一行一个位号，此条件与「该位号不在 BOM 中」完全等价；
 * 遇到一行多位号的少见情况时，该策略更保守，不会误删仍被需要的数据。
 */

import type { DesignatorParseResult } from './designators';
import type { BomCplCrossCheckResult, CplFilterResult } from './types';
import type { HeaderLocation, XlsxTable } from './xlsx';

import { difference, mergeDesignators, normalizeDesignator, parseDesignators, sortDesignators } from './designators';
import { getFileExtension } from './paths';
import { loadXlsx, locateHeader, readDesignatorColumn, removeRows } from './xlsx';

/* ------------------------------------------------------------------ *
 * CSV 支持（官方 API 也允许 csv 输出，作为兜底路径）
 * ------------------------------------------------------------------ */

/** 探测分隔符 */
function detectDelimiter(text: string): string {
	const firstLine = text.split(/\r?\n/u)[0] ?? '';
	const candidates = [',', ';', '\t', '|'];
	let best = ',';
	let bestCount = -1;
	for (const c of candidates) {
		const count = firstLine.split(c).length - 1;
		if (count > bestCount) {
			bestCount = count;
			best = c;
		}
	}
	return best;
}

/** 解析 CSV（支持双引号包裹与转义双引号） */
function parseCsv(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				}
				else {
					inQuotes = false;
				}
			}
			else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
		}
		else if (ch === delimiter) {
			row.push(field);
			field = '';
		}
		else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n')
				i++;
			row.push(field);
			field = '';
			rows.push(row);
			row = [];
		}
		else {
			field += ch;
		}
	}

	// 收尾
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

/** 序列化 CSV */
function stringifyCsv(rows: string[][], delimiter: string): string {
	const escape = (v: string): string => {
		if (v === undefined || v === null)
			return '';
		const s = String(v);
		if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r'))
			return `"${s.replace(/"/gu, '""')}"`;
		return s;
	};
	return rows.map(r => r.map(escape).join(delimiter)).join('\r\n');
}

/* ------------------------------------------------------------------ *
 * 表分析
 * ------------------------------------------------------------------ */

const DESIGNATOR_HEADER_ALIASES = [
	'designator',
	'designators',
	'designator(s)',
	'ref',
	'refdes',
	'reference',
	'references',
	'component',
	'componentreference',
	'partreference',
	'位号',
	'器件位号',
	'标号',
	'元件位号',
	'元件编号',
	'参考位号',
];

function normalizeHeaderText(text: string): string {
	return text
		.replace(/[\s*（）()【】[\]]/gu, '')
		.replace(/[：:]/gu, '')
		.toLowerCase();
}

/** 表格分析结果（xlsx 与 csv 统一视图） */
export interface TableAnalysis {
	kind: 'xlsx' | 'csv';
	/** 表体中出现的全部位号 */
	designators: DesignatorParseResult;
	/** 数据行总数（不含表头） */
	dataRowCount: number;
	/** 位号列的表头原文 */
	headerText: string;
	/** xlsx 专有数据 */
	xlsx?: {
		table: XlsxTable;
		header: HeaderLocation;
		entries: Array<{ rowIndex: number; value: string }>;
	};
	/** csv 专有数据 */
	csv?: {
		rows: string[][];
		delimiter: string;
		headerRowIndex: number;
		designatorCol: number;
	};
}

/**
 * 判断文件是否为 XLSX。
 *
 * 不能只看文件名后缀：官方 API 在某些情况下返回的 File 可能没有名称，
 * 此时若按后缀判断会误判为 CSV。因此先用后缀快速判断，
 * 后缀缺失或不可信时再**嗅探 ZIP 魔数**（XLSX 本质是 ZIP，开头恒为 `PK\x03\x04`）。
 */
async function looksLikeXlsx(file: File | Blob): Promise<boolean> {
	const ext = getFileExtension(file as File);
	if (ext === '.csv' || ext === '.txt')
		return false;
	if (ext === '.xlsx' || ext === '.xlsm')
		return true;

	// 后缀缺失或未知 → 嗅探内容
	try {
		const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
		return head[0] === 0x50 && head[1] === 0x4B
			&& (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
	}
	catch {
		// 连内容都读不到，按后缀结论处理（默认 CSV 路径会给出更清晰的错误）
		return false;
	}
}

/**
 * 分析一份 BOM 或 CPL 文件（自动识别 xlsx / csv）。
 * @throws 当找不到位号列、或文件无法解析时抛错，调用方负责记录到报告。
 */
export async function analyzeTable(file: File | Blob, fileName: string): Promise<TableAnalysis> {
	if (!(await looksLikeXlsx(file))) {
		const text = await file.text();
		return analyzeCsv(text);
	}

	const table = await loadXlsx(file, fileName);
	const header = locateHeader(table);
	if (!header) {
		throw new Error(
			`未能在 ${fileName} 中找到「位号 / Designator」列。`
			+ `已识别的列：${describeColumns(table)}`,
		);
	}

	const entries = readDesignatorColumn(table, header);
	const designators = mergeDesignators(entries.map(e => e.value));

	return {
		kind: 'xlsx',
		designators,
		dataRowCount: entries.length,
		headerText: header.headerText,
		xlsx: { table, header, entries },
	};
}

/** 把识别到的列名拼成诊断文本，帮助用户定位真实表头 */
function describeColumns(table: XlsxTable): string {
	if (table.rows.length === 0)
		return '(空表)';
	const first = table.rows[0];
	const names: string[] = [];
	for (const [col, value] of first.cells) {
		if ((value ?? '').trim() !== '')
			names.push(`${col}="${value}"`);
	}
	return names.length > 0 ? names.join(', ') : '(首行为空)';
}

function analyzeCsv(text: string): TableAnalysis {
	const delimiter = detectDelimiter(text);
	const rows = parseCsv(text, delimiter);

	let headerRowIndex = -1;
	let designatorCol = -1;
	let headerText = '';

	for (let r = 0; r < rows.length; r++) {
		const row = rows[r];
		for (let c = 0; c < row.length; c++) {
			const norm = normalizeHeaderText(row[c] ?? '');
			if (norm !== '' && DESIGNATOR_HEADER_ALIASES.includes(norm)) {
				headerRowIndex = r;
				designatorCol = c;
				headerText = row[c] ?? '';
				break;
			}
		}
		if (headerRowIndex >= 0)
			break;
	}

	if (headerRowIndex < 0) {
		throw new Error(
			`未能在 CSV 中找到「位号 / Designator」列。首行内容：${(rows[0] ?? []).join(' | ')}`,
		);
	}

	const values: string[] = [];
	for (let r = headerRowIndex + 1; r < rows.length; r++) {
		const v = (rows[r]?.[designatorCol] ?? '').trim();
		if (v !== '')
			values.push(v);
	}

	return {
		kind: 'csv',
		designators: mergeDesignators(values),
		dataRowCount: values.length,
		headerText,
		csv: { rows, delimiter, headerRowIndex, designatorCol },
	};
}

/* ------------------------------------------------------------------ *
 * 过滤
 * ------------------------------------------------------------------ */

/** CPL 过滤的完整产出 */
export interface CplFilterOutcome {
	/** 过滤后应写出的数据 */
	blob: Blob;
	/** 建议的输出文件名 */
	fileName: string;
	/** 统计结果 */
	result: CplFilterResult;
}

/**
 * 依据 BOM 位号集合过滤 CPL，并返回**保持原格式**的新文件。
 */
export async function filterCpl(
	cpl: TableAnalysis,
	bomDesignators: DesignatorParseResult,
	cplFileName: string,
): Promise<CplFilterOutcome> {
	// ---- XLSX 路径：删行 ----
	if (cpl.kind === 'xlsx' && cpl.xlsx) {
		const { table, entries } = cpl.xlsx;
		const removeRowIndexes: number[] = [];
		const removedDesignators = new Set<string>();
		let keptRows = 0;

		for (const entry of entries) {
			const parsed = parseDesignators(entry.value);
			const allAbsent = parsed.set.size > 0
				&& Array.from(parsed.set).every(d => !bomDesignators.set.has(d));

			if (allAbsent) {
				removeRowIndexes.push(entry.rowIndex);
				for (const d of parsed.originals)
					removedDesignators.add(d);
			}
			else {
				keptRows++;
			}
		}

		const blob = await removeRows(table, removeRowIndexes);
		const removedList = sortDesignators(Array.from(removedDesignators));

		return {
			blob,
			fileName: cplFileName,
			result: {
				executed: true,
				originalCount: entries.length,
				finalCount: keptRows,
				removedCount: removedList.length,
				removedDesignators: removedList,
			},
		};
	}

	// ---- CSV 路径：删行重建 ----
	if (cpl.kind === 'csv' && cpl.csv) {
		const { rows, delimiter, headerRowIndex, designatorCol } = cpl.csv;
		const keptRows: string[][] = rows.slice(0, headerRowIndex + 1);
		const removedDesignators = new Set<string>();
		let keptDataRows = 0;

		for (let r = headerRowIndex + 1; r < rows.length; r++) {
			const row = rows[r];
			const value = (row?.[designatorCol] ?? '').trim();
			const parsed = parseDesignators(value);
			const allAbsent = parsed.set.size > 0
				&& Array.from(parsed.set).every(d => !bomDesignators.set.has(d));

			if (allAbsent) {
				for (const d of parsed.originals)
					removedDesignators.add(d);
			}
			else {
				keptRows.push(row);
				if (value !== '')
					keptDataRows++;
			}
		}

		const removedList = sortDesignators(Array.from(removedDesignators));
		const csvText = stringifyCsv(keptRows, delimiter);

		return {
			blob: new Blob([csvText], { type: 'text/csv;charset=utf-8' }),
			fileName: cplFileName,
			result: {
				executed: true,
				originalCount: cpl.dataRowCount,
				finalCount: keptDataRows,
				removedCount: removedList.length,
				removedDesignators: removedList,
			},
		};
	}

	// 已知分支已全覆盖；走到这里说明上游数据结构异常，保守返回「未执行过滤」
	return {
		blob: new Blob([]),
		fileName: cplFileName,
		result: {
			executed: false,
			reason: `不支持的 CPL 格式：${cpl.kind}`,
			originalCount: 0,
			finalCount: 0,
			removedCount: 0,
			removedDesignators: [],
		},
	};
}

/**
 * 反向检查：BOM 中存在、但 CPL 中不存在的位号。
 * **仅告警，不自动补进 CPL** —— 可能是 THT 手焊件、机械件、无坐标元件或真实设计问题。
 */
export function crossCheckBomToCpl(
	bom: DesignatorParseResult,
	cpl: DesignatorParseResult,
): BomCplCrossCheckResult {
	return { missingInCpl: difference(bom, cpl) };
}

/** 判断一个位号是否在集合中（大小写无关） */
export function hasDesignator(set: Set<string>, value: string): boolean {
	return set.has(normalizeDesignator(value));
}

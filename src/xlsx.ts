/**
 * xlsx.ts —— 轻量 XLSX 读取 + 「保持 XLSX 格式删行」重写
 *
 * ## 为什么自己实现而不用第三方表格库
 * CPL 过滤只做两件事：**读出单元格文本** 和 **删掉若干行**。
 * 为此引入完整表格库（SheetJS 等）体积大、且存在新增依赖的供应链风险。
 * 项目已依赖 `jszip`（SDK 自带），而 XLSX 本质上就是一个 ZIP + XML，因此：
 *
 *   - **读取**：用 DOMParser 解析 `sharedStrings.xml` 与 `worksheets/sheetN.xml`（稳健）
 *   - **删行**：直接对**原始 XML 字符串**做「区间切除」，整块摘掉 `<row>…</row>`
 *
 * 这样做的关键好处：**XLSX 格式被完整保留**——`[Content_Types].xml`、样式、合并单元格、
 * 列宽等部件原封不动地回写，只是少了几行。Excel / WPS / JLCPCB 上传解析都能正常打开，
 * 不需要退化成 CSV，满足「首先研究是否能够在保持 XLSX 格式的情况下完成过滤」的要求。
 */

import JSZip from 'jszip';

/** 行在 XML 原文中的起止偏移 */
interface RowSpan {
	start: number;
	end: number;
}

/** 一行数据 */
export interface XlsxRow {
	/** 在 sheet 中的**文档顺序**下标（0 = 第一行），与 `rowSpans` 一一对应 */
	index: number;
	/** XML 里的行号引用，如 `r="5"` 中的 5；缺失时为 undefined */
	ref?: number;
	/** 列字母 → 单元格文本（已解引用共享字符串） */
	cells: Map<string, string>;
}

/** 已装载的表格 */
export interface XlsxTable {
	sourceName: string;
	zip: JSZip;
	sheetPath: string;
	sheetXml: string;
	rowSpans: RowSpan[];
	rows: XlsxRow[];
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 把 `A` / `AA` / `AB` 形式的列名转换为 0 基列序号 */
export function columnLetterToIndex(letter: string): number {
	let n = 0;
	for (const ch of letter.toUpperCase())
		n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
}

/** 0 基列序号转换为列名 */
export function columnIndexToLetter(index: number): string {
	let n = index + 1;
	let out = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		out = String.fromCharCode(65 + rem) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

/** 从 `C12` 这样的引用中取出列字母 */
function refToColumn(ref: string | null): string | undefined {
	if (!ref)
		return undefined;
	const m = /^([A-Z]+)/i.exec(ref);
	return m ? m[1].toUpperCase() : undefined;
}

/** 从 `C12` 这样的引用中取出行号；注意 `<row r="12">` 的行引用**只有数字没有列字母 */
function refToRowNumber(ref: string | null): number | undefined {
	if (!ref)
		return undefined;
	// 行引用可能是 "12"（row 元素），也可能是 "C12"（单元格元素）
	const m = /^[A-Z]*(\d+)$/i.exec(ref);
	if (!m)
		return undefined;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) ? n : undefined;
}

/** 取元素下所有 `<t>` 的文本（处理富文本多 run 的情况） */
function readRichText(el: Element): string {
	const parts: string[] = [];
	for (const t of Array.from(el.getElementsByTagName('t')))
		parts.push(t.textContent ?? '');
	if (parts.length === 0)
		return el.textContent ?? '';
	return parts.join('');
}

/**
 * 扫描原始 XML，记录每个 `<row>` 元素的字符区间（按文档顺序）。
 * `<row>` 不会嵌套，因此顺序扫描即可与 DOMParser 的行列表一一对应。
 */
function scanRowSpans(xml: string): RowSpan[] {
	const spans: RowSpan[] = [];
	let cursor = 0;

	while (cursor < xml.length) {
		const start = xml.indexOf('<row', cursor);
		if (start < 0)
			break;

		// 确认是 `<row` 而不是 `<rowSomething`（如不存在该标签，但保持严谨）
		const after = xml.charAt(start + 4);
		if (after !== '>' && after !== '/' && after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r') {
			cursor = start + 4;
			continue;
		}

		// 找到开始标签的结束位置（属性值中不会出现 `>`）
		const tagEnd = xml.indexOf('>', start);
		if (tagEnd < 0)
			break;

		// 自闭合：<row .../>
		if (xml.charAt(tagEnd - 1) === '/') {
			spans.push({ start, end: tagEnd + 1 });
			cursor = tagEnd + 1;
			continue;
		}

		const close = xml.indexOf('</row>', tagEnd);
		if (close < 0) {
			// 结构异常：不再继续，剩余内容视为无法切分
			break;
		}
		spans.push({ start, end: close + '</row>'.length });
		cursor = close + '</row>'.length;
	}

	return spans;
}

/* ------------------------------------------------------------------ *
 * 装载
 * ------------------------------------------------------------------ */

/** 定位第一个工作表 XML 的路径 */
async function resolveSheetPath(zip: JSZip): Promise<string | undefined> {
	// 先按标准关系查找，最稳妥
	try {
		const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
		const relsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
		if (workbookXml && relsXml) {
			const wbDoc = new DOMParser().parseFromString(workbookXml, 'application/xml');
			const firstSheet = wbDoc.getElementsByTagName('sheet')[0];
			const relId
				// r:id / id 在不同前缀下都可能出现，做成宽松匹配
				= firstSheet?.getAttribute('r:id')
					?? firstSheet?.getAttribute('id')
					?? firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
					?? undefined;

			if (relId) {
				const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
				for (const rel of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
					if (rel.getAttribute('Id') !== relId)
						continue;
					const target = rel.getAttribute('Target') ?? '';
					const normalized = target.startsWith('/')
						? target.slice(1)
						: `xl/${target.replace(/^\.\//, '')}`;
					if (zip.file(normalized))
						return normalized;
				}
			}
		}
	}
	catch {
		/* 关系解析失败则走兜底 */
	}

	// 兜底：取第一个 worksheets/sheet*.xml
	const candidates = Object.keys(zip.files)
		.filter(p => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
		.sort((a, b) => {
			const na = Number.parseInt(/sheet(\d+)\.xml$/i.exec(a)?.[1] ?? '0', 10);
			const nb = Number.parseInt(/sheet(\d+)\.xml$/i.exec(b)?.[1] ?? '0', 10);
			return na - nb;
		});

	return candidates[0];
}

/** 解析共享字符串表 */
async function readSharedStrings(zip: JSZip): Promise<string[]> {
	const xml = await zip.file('xl/sharedStrings.xml')?.async('string');
	if (!xml)
		return [];

	try {
		const doc = new DOMParser().parseFromString(xml, 'application/xml');
		return Array.from(doc.getElementsByTagName('si')).map(si => readRichText(si));
	}
	catch {
		return [];
	}
}

/** 解析工作表的所有行与单元格 */
function parseSheetRows(sheetXml: string, sharedStrings: string[]): XlsxRow[] {
	const doc = new DOMParser().parseFromString(sheetXml, 'application/xml');
	const rowEls = Array.from(doc.getElementsByTagName('row'));
	const rows: XlsxRow[] = [];

	for (let i = 0; i < rowEls.length; i++) {
		const rowEl = rowEls[i];
		const cells = new Map<string, string>();
		let fallbackCol = 0;

		for (const c of Array.from(rowEl.getElementsByTagName('c'))) {
			const ref = c.getAttribute('r');
			const col = refToColumn(ref) ?? columnIndexToLetter(fallbackCol);
			fallbackCol = columnLetterToIndex(col) + 1;

			const type = c.getAttribute('t');
			let value = '';

			if (type === 'inlineStr') {
				const is = c.getElementsByTagName('is')[0];
				value = is ? readRichText(is) : '';
			}
			else {
				const vEl = c.getElementsByTagName('v')[0];
				const raw = vEl?.textContent ?? '';
				if (type === 's') {
					const idx = Number.parseInt(raw, 10);
					value = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length
						? sharedStrings[idx]
						: '';
				}
				else {
					value = raw;
				}
			}

			cells.set(col, value);
		}

		rows.push({
			index: i,
			ref: refToRowNumber(rowEl.getAttribute('r')),
			cells,
		});
	}

	return rows;
}

/** 从 File/Blob 装载 XLSX。 */
export async function loadXlsx(source: File | Blob, sourceName: string): Promise<XlsxTable> {
	const buffer = await source.arrayBuffer();
	const zip = await JSZip.loadAsync(buffer);

	const sheetPath = await resolveSheetPath(zip);
	if (!sheetPath)
		throw new Error('XLSX 中未找到工作表（xl/worksheets/sheetN.xml）');

	const sheetXml = await zip.file(sheetPath)?.async('string');
	if (sheetXml === undefined)
		throw new Error(`无法读取工作表内容：${sheetPath}`);

	const sharedStrings = await readSharedStrings(zip);
	const rows = parseSheetRows(sheetXml, sharedStrings);
	const rowSpans = scanRowSpans(sheetXml);

	return { sourceName, zip, sheetPath, sheetXml, rowSpans, rows };
}

/* ------------------------------------------------------------------ *
 * 表头与列定位
 * ------------------------------------------------------------------ */

/** 位号列可能的表头名称（英文 / 中文，大小写与空白无关） */
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

function normalizeHeader(text: string): string {
	return text
		.replace(/[\s*（）()【】[\]]/gu, '')
		.replace(/[：:]/gu, '')
		.toLowerCase();
}

/** 在给定行中查找位号列 */
function findDesignatorColumn(row: XlsxRow): string | undefined {
	for (const [col, value] of row.cells) {
		const norm = normalizeHeader(value ?? '');
		if (norm === '')
			continue;
		if (DESIGNATOR_HEADER_ALIASES.includes(norm))
			return col;
	}
	return undefined;
}

/** 表头定位结果 */
export interface HeaderLocation {
	/** 表头所在行在 `rows` 中的下标 */
	headerRowIndex: number;
	/** 位号列的列字母 */
	designatorColumn: string;
	/** 表头原文（用于报告） */
	headerText: string;
}

/**
 * 从上往下寻找表头行。
 * 取「第一个能找到位号列的行」为表头，其后的行均为数据行。
 */
export function locateHeader(table: XlsxTable): HeaderLocation | undefined {
	for (const row of table.rows) {
		const col = findDesignatorColumn(row);
		if (col) {
			return {
				headerRowIndex: row.index,
				designatorColumn: col,
				headerText: row.cells.get(col) ?? '',
			};
		}
	}
	return undefined;
}

/** 读取表体中的位号（不含表头行） */
export function readDesignatorColumn(
	table: XlsxTable,
	location: HeaderLocation,
): Array<{ rowIndex: number; value: string }> {
	const out: Array<{ rowIndex: number; value: string }> = [];
	for (const row of table.rows) {
		if (row.index <= location.headerRowIndex)
			continue;
		const value = (row.cells.get(location.designatorColumn) ?? '').trim();
		if (value === '')
			continue;
		out.push({ rowIndex: row.index, value });
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * 删行并回写
 * ------------------------------------------------------------------ */

/**
 * 重写单行的行号。
 *
 * ⚠️ 只删 `<row>` 元素而不改行号，会在表格里留下**空洞**（第 5、8、12 行变空），
 * 交付给贴片厂时观感很差。因此这里把保留下来的行**连续重排**为 1..N，
 * 同步修改 `<row r="...">` 与其中每个 `<c r="...">` 的单元格引用。
 */
function renumberRow(rawRow: string, newRowNumber: number): string {
	let out = rawRow.replace(
		/(<row[^>]*?\sr=")\d+(")/u,
		`$1${newRowNumber}$2`,
	);
	// 单元格引用：保留列字母，只改行号部分
	out = out.replace(
		/(<c[^>]*?\sr=")([A-Za-z]+)\d+(")/gu,
		`$1$2${newRowNumber}$3`,
	);
	return out;
}

/** 取表格中实际使用的最大列序号 */
function computeMaxColumnIndex(rows: XlsxRow[]): number {
	let max = 0;
	for (const row of rows) {
		for (const col of row.cells.keys())
			max = Math.max(max, columnLetterToIndex(col));
	}
	return max;
}

/**
 * 依据「保留哪些行」重建 sheetData。
 *
 * @param table     已装载的表格
 * @param keepRows  保留下来的行（保持原有顺序）
 */
function rebuildSheetData(table: XlsxTable, keepRows: XlsxRow[]): string {
	const xml = table.sheetXml;

	const openMatch = /<sheetData\b[^>]*>/u.exec(xml);
	if (!openMatch)
		throw new Error('工作表缺少 sheetData 节点，无法重写。');

	const contentStart = openMatch.index + openMatch[0].length;
	const closeIndex = xml.indexOf('</sheetData>', contentStart);
	if (closeIndex < 0)
		throw new Error('工作表 sheetData 节点未闭合，无法重写。');

	// 旧行号 → 新行号 的映射（用于同步合并单元格）
	const rowMap = new Map<number, number>();
	const parts: string[] = [];
	let nextRowNumber = 0;

	for (const row of keepRows) {
		const span = table.rowSpans[row.index];
		if (!span)
			throw new Error(`行 ${row.index} 在 XML 中找不到对应区间，无法重写。`);

		nextRowNumber += 1;
		if (row.ref !== undefined)
			rowMap.set(row.ref, nextRowNumber);

		parts.push(renumberRow(xml.slice(span.start, span.end), nextRowNumber));
	}

	let out = xml.slice(0, contentStart) + parts.join('') + xml.slice(closeIndex);

	// ---- 修正 dimension ----
	if (nextRowNumber > 0) {
		const newRef = `A1:${columnIndexToLetter(computeMaxColumnIndex(keepRows))}${nextRowNumber}`;
		out = out.replace(
			/(<dimension[^>]*?\sref=")[^"]*(")/u,
			`$1${newRef}$2`,
		);
	}

	// ---- 同步合并单元格：重排引用；引用了已删除行的合并直接丢弃 ----
	if (out.includes('<mergeCell')) {
		out = out.replace(
			/<mergeCell[^>]*?\sref="([A-Za-z]+\d+:[A-Za-z]+\d+)"[^>]*\/>/gu,
			(match, ref: string) => {
				const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/u.exec(ref);
				if (!m)
					return match;
				const startRow = rowMap.get(Number.parseInt(m[2], 10));
				const endRow = rowMap.get(Number.parseInt(m[4], 10));
				if (startRow === undefined || endRow === undefined)
					return ''; // 引用的行已被删除 → 丢弃该合并
				return match.replace(
					`ref="${ref}"`,
					`ref="${m[1]}${startRow}:${m[3]}${endRow}"`,
				);
			},
		);

		const remainingMerges = (out.match(/<mergeCell\s/gu) ?? []).length;
		out = out.replace(
			/(<mergeCells[^>]*?\scount=")\d+(")/u,
			`$1${remainingMerges}$2`,
		);
	}

	return out;
}

/**
 * 保守回退：只做区间切除，不重排行号。
 * 仅在 XML 结构与解析结果对不上（`rowSpans` 与 `rows` 数量不一致）时使用。
 */
function spliceRowsFromXml(table: XlsxTable, removeSet: Set<number>): string {
	const spansToRemove = table.rowSpans
		.map((span, index) => ({ span, index }))
		.filter(item => removeSet.has(item.index))
		.sort((a, b) => b.span.start - a.span.start);

	let out = table.sheetXml;
	for (const item of spansToRemove)
		out = out.slice(0, item.span.start) + out.slice(item.span.end);

	return out;
}

/** 用新的工作表 XML 重新打包（其余部件原封不动） */
async function repack(table: XlsxTable, newSheetXml: string): Promise<Blob> {
	const outZip = new JSZip();
	for (const path of Object.keys(table.zip.files)) {
		const entry = table.zip.files[path];
		if (entry.dir)
			continue;

		if (path === table.sheetPath)
			outZip.file(path, newSheetXml);
		else
			outZip.file(path, await entry.async('uint8array'));
	}

	return outZip.generateAsync({
		type: 'blob',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
		mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	});
}

/**
 * 删除指定行，并**保持 XLSX 格式**返回新的 Blob。
 *
 * - 保留下来的行会被重排为连续行号（不留下空白行）
 * - 只替换工作表这一个部件，其余部件（样式、列宽、共享字符串…）原封不动
 *
 * @param table         已装载的表格
 * @param removeIndexes 需要删除的行下标（`XlsxRow.index`）
 */
export async function removeRows(table: XlsxTable, removeIndexes: Iterable<number>): Promise<Blob> {
	const removeSet = new Set(removeIndexes);

	if (removeSet.size === 0)
		return repack(table, table.sheetXml);

	// XML 结构对不上时走保守路径，宁愿留空洞也不冒错位风险
	if (table.rowSpans.length !== table.rows.length) {
		return repack(table, spliceRowsFromXml(table, removeSet));
	}

	const keepRows = table.rows.filter(row => !removeSet.has(row.index));
	const newSheetXml = keepRows.length === 0
		? spliceRowsFromXml(table, removeSet)
		: rebuildSheetData(table, keepRows);

	return repack(table, newSheetXml);
}

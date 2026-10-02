/**
 * logic.test.ts —— 核心算法真实功能测试（Node 环境运行，不依赖 EasyEDA）
 *
 * 覆盖：
 *   1. 位号解析：逗号/空格/顿号/换行分隔、区间展开、补零、大小写、集合运算
 *   2. XLSX 读取：共享字符串解引用、表头定位、位号列识别
 *   3. CPL 过滤：真实构造 XLSX → 过滤 → 回读校验（行数、被删行、格式保留）
 *   4. 反向检查：BOM 有而 CPL 无
 *
 * 运行方式见 tests/run.sh：用 esbuild 打包本文件后在 Node 中执行。
 */

import JSZip from 'jszip';
// linkedom 提供 DOMParser（浏览器内置，Node 没有），必须在调用前注入
import { DOMParser as LinkeDOMParser } from 'linkedom';
import { analyzeTable, crossCheckBomToCpl, filterCpl } from '../src/bomCpl';
import { CAPABILITY_KEYS, getCapabilities, invalidateCapabilities, isVersionAtLeast, missingCapabilities, parseEdaVersion } from '../src/capabilities';
import { difference, mergeDesignators, parseDesignators } from '../src/designators';
import { ApiTimeoutError, attempt, softCall, withTimeout } from '../src/edaCompat';
import { buildManufacturingRequirements, embedRequirementsInGerber, REQUIREMENTS_FILE_EN, REQUIREMENTS_FILE_ZH } from '../src/manufacturing';
import { dirnameOf, formatLocalDateYmd, joinPath, sanitizeName, validateBaseDir } from '../src/paths';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { loadXlsx, locateHeader, readDesignatorColumn } from '../src/xlsx';

(globalThis as unknown as { DOMParser: unknown }).DOMParser = LinkeDOMParser;

/* ------------------------------------------------------------------ *
 * 极简断言
 * ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, extra?: string): void {
	if (condition) {
		passed++;
		console.log(`  PASS  ${name}`);
	}
	else {
		failures.push(name);
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
	}
}

function eq<T>(name: string, actual: T, expected: T): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	check(name, a === e, `expected ${e}, got ${a}`);
}

/* ------------------------------------------------------------------ *
 * XLSX 构造工具
 * ------------------------------------------------------------------ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function colLetter(i: number): string {
	let n = i + 1;
	let out = '';
	while (n > 0) {
		const rem = (n - 1) % 26;
		out = String.fromCharCode(65 + rem) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
}

/** 用共享字符串表构造一个最小但结构完整的 XLSX */
async function buildXlsx(rows: string[][], mergeCells?: string[]): Promise<Blob> {
	const shared: string[] = [];
	const sharedIndex = new Map<string, number>();
	const intern = (v: string): number => {
		if (sharedIndex.has(v))
			return sharedIndex.get(v) as number;
		const idx = shared.length;
		shared.push(v);
		sharedIndex.set(v, idx);
		return idx;
	};

	const rowXml: string[] = [];
	rows.forEach((cells, r) => {
		const cellXml: string[] = [];
		cells.forEach((value, c) => {
			const ref = `${colLetter(c)}${r + 1}`;
			if (value === '') {
				cellXml.push(`<c r="${ref}"/>`);
				return;
			}
			// 纯数字写成数值型，其余写入共享字符串表 —— 与实际表格软件行为一致
			if (/^-?\d+(?:\.\d+)?$/.test(value))
				cellXml.push(`<c r="${ref}"><v>${value}</v></c>`);
			else
				cellXml.push(`<c r="${ref}" t="s"><v>${intern(value)}</v></c>`);
		});
		rowXml.push(`<row r="${r + 1}">${cellXml.join('')}</row>`);
	});

	const lastCol = colLetter(Math.max(...rows.map(r => r.length)) - 1);
	const mergeXml = mergeCells && mergeCells.length > 0
		? `<mergeCells count="${mergeCells.length}">${mergeCells.map(r => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>`
		: '';
	const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${rows.length}"/>
<sheetData>${rowXml.join('')}</sheetData>${mergeXml}
</worksheet>`;

	const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">
${shared.map(s => `<si><t>${escapeXml(s)}</t></si>`).join('')}
</sst>`;

	const zip = new JSZip();
	zip.file('[Content_Types].xml', CONTENT_TYPES);
	zip.file('_rels/.rels', ROOT_RELS);
	zip.file('xl/workbook.xml', WORKBOOK);
	zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
	zip.file('xl/worksheets/sheet1.xml', sheet);
	zip.file('xl/sharedStrings.xml', sst);
	return zip.generateAsync({ type: 'blob' });
}

/* ------------------------------------------------------------------ *
 * 测试主体
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
	// ================= 1. 位号解析 =================
	console.log('\n[1] 位号解析');

	eq('逗号无空格 R1,R2,R3', parseDesignators('R1,R2,R3').originals, ['R1', 'R2', 'R3']);
	eq('逗号带空格 R1, R2, R3', parseDesignators('R1, R2, R3').originals, ['R1', 'R2', 'R3']);
	eq('空格分隔 R1 R2 R3', parseDesignators('R1 R2 R3').originals, ['R1', 'R2', 'R3']);
	eq('顿号 R1、R2', parseDesignators('R1、R2').originals, ['R1', 'R2']);
	eq('分号 R1;R2', parseDesignators('R1;R2').originals, ['R1', 'R2']);
	eq('换行分隔', parseDesignators('R1\nR2\nC1').originals, ['R1', 'R2', 'C1']);
	eq('区间 R1-R5', parseDesignators('R1-R5').originals, ['R1', 'R2', 'R3', 'R4', 'R5']);
	eq('区间上界省略前缀 R1-5', parseDesignators('R1-5').originals, ['R1', 'R2', 'R3', 'R4', 'R5']);
	eq('区间保留补零 R01-R03', parseDesignators('R01-R03').originals, ['R01', 'R02', 'R03']);
	eq('前缀不一致不展开 C1-R3', parseDesignators('C1-R3').originals, ['C1-R3']);
	eq('倒序区间不展开 R5-R1', parseDesignators('R5-R1').originals, ['R5-R1']);
	eq('大小写归一（集合内）', Array.from(parseDesignators('r1,R1,c2').set), ['R1', 'C2']);
	eq('空串', parseDesignators('').originals, []);
	eq('null', parseDesignators(null).originals, []);

	// mergeDesignators：BOM 同一料号跨多行
	const merged = mergeDesignators(['R1,R2', 'R3', 'C1', 'R2']);
	eq('合并多行位号', merged.originals, ['R1', 'R2', 'R3', 'C1']);

	// difference
	const bom = parseDesignators('R1,R2,R3,C1,U1');
	const cpl = parseDesignators('R1,R2,R3,C1');
	eq('BOM 有而 CPL 无', difference(bom, cpl), ['U1']);

	// ================= 2. XLSX 读取 =================
	console.log('\n[2] XLSX 读取');

	const bomRows = [
		['Designator', 'Comment', 'Quantity'],
		['R1,R2,R3', '10k', '3'],
		['C1, C2', '100nF', '2'],
		['R10-R12', '1k', '3'],
		['U1', 'MCU', '1'],
	];
	const bomBlob = await buildXlsx(bomRows);

	const bomTable = await loadXlsx(bomBlob, 'test_BOM.xlsx');
	eq('BOM 行数', bomTable.rows.length, 5);
	eq('共享字符串解引用（表头）', bomTable.rows[0].cells.get('A'), 'Designator');
	eq('合并位号单元格原文', bomTable.rows[1].cells.get('A'), 'R1,R2,R3');

	const bomHeader = locateHeader(bomTable);
	check('BOM 表头定位', !!bomHeader);
	eq('BOM 位号列', bomHeader?.designatorColumn, 'A');
	const bomEntries = readDesignatorColumn(bomTable, bomHeader!);
	eq('BOM 数据行数', bomEntries.length, 4);

	const bomAnalysis = await analyzeTable(bomBlob, 'test_BOM.xlsx');
	eq('BOM 位号集合', Array.from(bomAnalysis.designators.set).sort(), ['C1', 'C2', 'R1', 'R10', 'R11', 'R12', 'R2', 'R3', 'U1']);

	// 中文表头识别（位号在 B 列，数据必须落在同一列）
	const zhBom = await buildXlsx([
		['序号', '位号', '数量'],
		['1', 'R1, R2', '2'],
	]);
	const zhAnalysis = await analyzeTable(zhBom, 'zh_BOM.xlsx');
	eq('中文「位号」表头识别', Array.from(zhAnalysis.designators.set).sort(), ['R1', 'R2']);

	// 无文件名的 Blob 也必须能正确识别（内容嗅探）
	const anonymousXlsx = await buildXlsx([
		['Designator', 'Comment'],
		['R7, R8', '1k'],
	]);
	const anonymousAnalysis = await analyzeTable(anonymousXlsx, '(unnamed)');
	eq('无文件名 Blob 内容嗅探识别为 XLSX', Array.from(anonymousAnalysis.designators.set).sort(), ['R7', 'R8']);

	// ================= 3. CPL 过滤（核心功能） =================
	console.log('\n[3] CPL 过滤');

	// 场景完全对应任务书第十节的例子
	const cplRows = [
		['Designator', 'Mid X', 'Mid Y', 'Layer'],
		['R1', '10.5', '20.1', 'Top'],
		['R2', '15.2', '20.1', 'Top'],
		['R3', '20.0', '20.1', 'Top'],
		['R4', '25.0', '20.1', 'Top'], // 不在 BOM 中 → 应删除
		['C1', '30.0', '20.1', 'Top'],
		['C2', '35.0', '20.1', 'Top'],
		['USB1', '40.0', '20.1', 'Top'], // 不在 BOM 中 → 应删除
		['R10', '45.0', '20.1', 'Top'],
		['R11', '50.0', '20.1', 'Top'],
		['R12', '55.0', '20.1', 'Top'],
		['R13', '60.0', '20.1', 'Top'], // 不在 BOM 中 → 应删除
	];
	const cplBlob = await buildXlsx(cplRows);
	const cplAnalysis = await analyzeTable(cplBlob, 'test_CPL.xlsx');
	eq('CPL 原始数据行数', cplAnalysis.dataRowCount, 11);

	const outcome = await filterCpl(cplAnalysis, bomAnalysis.designators, 'test_CPL.xlsx');
	eq('过滤 executed', outcome.result.executed, true);
	eq('CPL Original', outcome.result.originalCount, 11);
	eq('CPL Final', outcome.result.finalCount, 8);
	eq('CPL Removed 数量', outcome.result.removedCount, 3);
	eq('CPL Removed 清单', outcome.result.removedDesignators, ['R4', 'R13', 'USB1']);

	// ---- 回读过滤后的文件，验证真的被删干净了 ----
	const filteredTable = await loadXlsx(outcome.blob, 'filtered.xlsx');
	const filteredHeader = locateHeader(filteredTable)!;
	const filteredEntries = readDesignatorColumn(filteredTable, filteredHeader);
	eq('过滤后回读：数据行数', filteredEntries.length, 8);
	eq('过滤后回读：位号清单', filteredEntries.map(e => e.value), ['R1', 'R2', 'R3', 'C1', 'C2', 'R10', 'R11', 'R12']);
	check('过滤后回读：R4 已删除', !filteredEntries.some(e => e.value === 'R4'));
	check('过滤后回读：USB1 已删除', !filteredEntries.some(e => e.value === 'USB1'));
	check('过滤后回读：R13 已删除', !filteredEntries.some(e => e.value === 'R13'));
	check('过滤后回读：表头仍为 Designator', filteredTable.rows[0].cells.get('A') === 'Designator');

	// 坐标数据必须完整保留（没被误删列/错位）
	eq('过滤后回读：首行坐标数据完整', [filteredTable.rows[1].cells.get('A'), filteredTable.rows[1].cells.get('B'), filteredTable.rows[1].cells.get('C'), filteredTable.rows[1].cells.get('D')], ['R1', '10.5', '20.1', 'Top']);
	eq('过滤后回读：末行坐标数据完整', [filteredTable.rows[8].cells.get('A'), filteredTable.rows[8].cells.get('B'), filteredTable.rows[8].cells.get('C')], ['R12', '55.0', '20.1']);

	// ---- 验证 XLSX 格式被保留（仍是合法 zip 且部件齐全） ----
	const reZip = await JSZip.loadAsync(await outcome.blob.arrayBuffer());
	check('格式保留：[Content_Types].xml 存在', !!reZip.file('[Content_Types].xml'));
	check('格式保留：workbook.xml 存在', !!reZip.file('xl/workbook.xml'));
	check('格式保留：sharedStrings.xml 存在', !!reZip.file('xl/sharedStrings.xml'));
	check('格式保留：sheet1.xml 存在', !!reZip.file('xl/worksheets/sheet1.xml'));
	const sheetAfter = await reZip.file('xl/worksheets/sheet1.xml')!.async('string');
	check('格式保留：仍为 worksheet XML', sheetAfter.includes('<worksheet'));
	check('格式保留：dimension 已重算为 A1:D9', /dimension[^>]*ref="A1:D9"/.test(sheetAfter), sheetAfter.slice(0, 300));
	check('格式保留：sheetData 行数正确', (sheetAfter.match(/<row /g) ?? []).length === 9);

	// ---- 行号必须连续重排，不能留空洞 ----
	const rowNumbers = Array.from(sheetAfter.matchAll(/<row[^>]*?\sr="(\d+)"/g)).map(m => Number(m[1]));
	eq('行号连续重排为 1..9', rowNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
	const cellRefs = Array.from(sheetAfter.matchAll(/<c[^>]*?\sr="([A-Z]+)(\d+)"/g))
		.map(m => Number(m[2]));
	const maxCellRow = Math.max(...cellRefs);
	check('单元格行号不超过 9（无残留引用）', maxCellRow === 9, `maxCellRow=${maxCellRow}`);
	check('单元格行号无空洞', Array.from(new Set(cellRefs)).sort((a, b) => a - b).join(',') === '1,2,3,4,5,6,7,8,9', Array.from(new Set(cellRefs)).sort((a, b) => a - b).join(','));

	// ---- 合并单元格同步 ----
	// 输入行号：1=表头 2=R1 3=R2 4=R3；R2 将被删除
	const mergedBlob = await buildXlsx([
		['Designator', 'Mid X'],
		['R1', '1'],
		['R2', '2'],
		['R3', '3'],
	], ['A1:B1', 'A2:B2', 'A3:B3', 'A4:B4']);
	const mergedAnalysis = await analyzeTable(mergedBlob, 'merged.xlsx');
	const mergedOut = await filterCpl(
		mergedAnalysis,
		parseDesignators('R1,R3'),
		'merged.xlsx',
	);
	eq('合并场景 removedCount', mergedOut.result.removedCount, 1);

	const mergedZip = await JSZip.loadAsync(await mergedOut.blob.arrayBuffer());
	const mergedSheet = await mergedZip.file('xl/worksheets/sheet1.xml')!.async('string');
	const mergeRefs = Array.from(mergedSheet.matchAll(/<mergeCell[^>]*?\sref="([^"]+)"/g))
		.map(m => m[1]);
	// 1=表头→1、2=R1→2、4=R3→3；3=R2 被删除其合并应丢弃
	eq('合并单元格重排 + 丢弃被删行的合并', mergeRefs, ['A1:B1', 'A2:B2', 'A3:B3']);
	check('合并单元格 count 已同步为 3', /mergeCells[^>]*count="3"/.test(mergedSheet), mergedSheet);

	// ---- 无删除场景 ----
	const cleanCpl = await buildXlsx([
		['Designator', 'Mid X'],
		['R1', '1'],
		['R2', '2'],
	]);
	const cleanOutcome = await filterCpl(
		await analyzeTable(cleanCpl, 'clean.xlsx'),
		bomAnalysis.designators,
		'clean.xlsx',
	);
	eq('无需删除时 removedCount', cleanOutcome.result.removedCount, 0);
	eq('无需删除时 finalCount', cleanOutcome.result.finalCount, 2);

	// ================= 4. 反向检查 =================
	console.log('\n[4] 反向检查 BOM → CPL');
	const cross = crossCheckBomToCpl(bomAnalysis.designators, cplAnalysis.designators);
	eq('BOM 有而 CPL 无（U1）', cross.missingInCpl, ['U1']);

	const cross2 = crossCheckBomToCpl(
		parseDesignators('R1,J3,SW2,J5'),
		parseDesignators('R1'),
	);
	eq('多个缺失位号', cross2.missingInCpl, ['J3', 'J5', 'SW2']);

	// ================= 5. CSV 兜底路径 =================
	console.log('\n[5] CSV 兜底路径');
	const csvCpl = new Blob([
		'Designator,Mid X,Mid Y\nR1,1,2\nR2,3,4\nR99,5,6\n',
	], { type: 'text/csv' });
	const csvAnalysis = await analyzeTable(csvCpl, 'cpl.csv');
	eq('CSV 位号集合', Array.from(csvAnalysis.designators.set).sort(), ['R1', 'R2', 'R99']);
	const csvOutcome = await filterCpl(csvAnalysis, bomAnalysis.designators, 'cpl.csv');
	eq('CSV 过滤 removed', csvOutcome.result.removedDesignators, ['R99']);
	eq('CSV 过滤 final', csvOutcome.result.finalCount, 2);
	check('CSV 过滤保留表头', (await csvOutcome.blob.text()).startsWith('Designator,Mid X'));
	check('CSV 过滤移除 R99', !(await csvOutcome.blob.text()).includes('R99'));

	// ================= 6. 设置模型：必选项强制 + 旧版迁移 =================
	console.log('\n[6] 设置模型 normalizeSettings');

	// 6.1 必选项不可被关闭（用户要求「gerber，bom 和坐标文件是默认必选的」）
	const forced = normalizeSettings({
		exportGerber: false,
		exportBom: false,
		exportCpl: false,
		export3DHtml: true,
	});
	eq('Gerber 必选恒为 true', forced.exportGerber, true);
	eq('BOM 必选恒为 true', forced.exportBom, true);
	eq('CPL 必选恒为 true', forced.exportCpl, true);
	eq('3D HTML 恒为 false', forced.export3DHtml, false);
	eq('默认板厚 1.6mm', forced.boardThicknessMm, '1.6');
	eq('默认阻焊绿色', forced.solderMaskColor, 'Green');
	eq('默认字符白色', forced.silkscreenColor, 'White');
	eq('默认表面处理无铅喷锡', forced.surfaceFinish, 'Lead-Free HASL');
	eq('默认不启用阻抗控制', forced.impedanceControl, false);

	// 6.2 可选项正常保留
	const custom = normalizeSettings({
		exportSchematicPdf: false,
		exportStep: false,
		exportInteractiveBom: false,
		exportProjectV3: false,
		exportProjectV2: true,
		runDrc: false,
		outputDir: '  D:/PCB_Out  ',
	});
	eq('可选项 PDF=false', custom.exportSchematicPdf, false);
	eq('可选项 STEP=false', custom.exportStep, false);
	eq('可选项 iBOM=false', custom.exportInteractiveBom, false);
	eq('可选项 ProjectV3=false', custom.exportProjectV3, false);
	eq('可选项 ProjectV2=true', custom.exportProjectV2, true);
	eq('可选项 runDrc=false', custom.runDrc, false);
	eq('outputDir 去首尾空格', custom.outputDir, 'D:/PCB_Out');

	const fabrication = normalizeSettings({
		boardThicknessMm: '0.8',
		solderMaskColor: 'Purple',
		silkscreenColor: 'Black',
		surfaceFinish: 'ENIG',
		impedanceControl: true,
		manufacturingNotes: '  50 ohm ±10%  ',
	});
	eq('制造要求板厚可保存', fabrication.boardThicknessMm, '0.8');
	eq('制造要求阻焊可保存', fabrication.solderMaskColor, 'Purple');
	eq('制造要求字符可保存', fabrication.silkscreenColor, 'Black');
	eq('制造要求表面处理可保存', fabrication.surfaceFinish, 'ENIG');
	eq('制造要求阻抗控制可保存', fabrication.impedanceControl, true);
	eq('制造要求备注去首尾空格', fabrication.manufacturingNotes, '50 ohm ±10%');
	eq('非法板厚回退默认值', normalizeSettings({ boardThicknessMm: '9.9' }).boardThicknessMm, '1.6');

	const requirementText = buildManufacturingRequirements({
		boardThicknessMm: '1.6',
		solderMaskColor: 'Green',
		silkscreenColor: 'White',
		surfaceFinish: 'Lead-Free HASL',
		impedanceControl: true,
		customNotes: 'USB 90 ohm',
	}, 'Demo Board', '2026-10-02 12:00:00');
	check('制造要求为中英双语', requirementText.includes('板厚 / Board thickness: 1.6 mm'));
	check('制造要求含下单页复核警告', requirementText.includes('manufacturer order page'));
	const gerberSource = new JSZip();
	gerberSource.file('demo.gbr', 'G04 demo*');
	const gerberBlob = new Blob([await gerberSource.generateAsync({ type: 'uint8array' })]);
	const embedded = await JSZip.loadAsync(await (await embedRequirementsInGerber(gerberBlob, requirementText)).arrayBuffer());
	check('Gerber ZIP 含中文名制造要求', embedded.file(REQUIREMENTS_FILE_ZH) !== null);
	check('Gerber ZIP 含英文名制造要求', embedded.file(REQUIREMENTS_FILE_EN) !== null);

	// 6.3 v1.0.0 旧设置迁移：projectFormat='V2' + exportProject=true
	const migratedV2 = normalizeSettings({ exportProject: true, projectFormat: 'V2' });
	eq('迁移 V2 → ProjectV3=false', migratedV2.exportProjectV3, false);
	eq('迁移 V2 → ProjectV2=true', migratedV2.exportProjectV2, true);

	// 6.4 v1.0.0 旧设置迁移：exportProject=false
	const migratedOff = normalizeSettings({ exportProject: false, projectFormat: 'V3' });
	eq('迁移 exportProject=false → V3=false', migratedOff.exportProjectV3, false);
	eq('迁移 exportProject=false → V2=false', migratedOff.exportProjectV2, false);

	// 6.5 脏数据回退默认值
	const dirty = normalizeSettings({ exportStep: 'yes', outputDir: 12345, runDrc: null });
	eq('脏数据 exportStep 回退默认', dirty.exportStep, DEFAULT_SETTINGS.exportStep);
	eq('脏数据 outputDir 回退为空串', dirty.outputDir, '');
	eq('脏数据 runDrc 回退默认', dirty.runDrc, DEFAULT_SETTINGS.runDrc);

	// 6.6 非对象入参
	eq('null 入参 → 全默认', normalizeSettings(null), DEFAULT_SETTINGS);

	// ================= 7. 文件名安全与路径工具 =================
	console.log('\n[7] 文件名安全与路径工具');

	// 7.1 Windows 非法字符全部替换为 _
	eq('非法字符替换', sanitizeName('A/B\\C:D*E?F"G<H>I|J'), 'A_B_C_D_E_F_G_H_I_J');
	// 7.2 合法字符必须保留（空格、中文、连字符、括号都是合法的）
	eq('首尾空格被 trim 但中间保留', sanitizeName('  My Board  '), 'My Board');
	eq('中文与空格保留', sanitizeName('测试 板 v2'), '测试 板 v2');
	// 7.3 控制字符替换
	eq('控制字符替换', sanitizeName(`A${String.fromCodePoint(1)}B`), 'A_B');
	// 7.4 连续下划线折叠
	eq('连续下划线折叠', sanitizeName('R//R'), 'R_R');
	// 7.5 兜底
	eq('空串兜底', sanitizeName(''), 'PCB_Project');
	eq('仅点号兜底', sanitizeName('...'), 'PCB_Project');

	// 7.6 日期必须使用本地日期而非 UTC
	eq('本地日期格式化', formatLocalDateYmd(new Date(2026, 8, 30)), '20260930');
	eq('本地日期补零', formatLocalDateYmd(new Date(2026, 0, 5)), '20260105');

	// 7.7 目录校验
	eq('Windows 绝对路径通过', validateBaseDir('D:\\PCB_Out'), undefined);
	eq('正斜杠绝对路径通过', validateBaseDir('/home/user/out'), undefined);
	eq('相对路径被拒', validateBaseDir('output'), 'NOT_ABSOLUTE');
	eq('空目录被拒', validateBaseDir('   '), 'EMPTY');

	// 7.8 路径拼接：沿用原目录的分隔符风格
	eq('反斜杠目录拼接', joinPath('D:\\PCB_Out\\', 'Board_20260930'), 'D:\\PCB_Out\\Board_20260930');
	eq('正斜杠目录拼接', joinPath('D:/PCB_Out', 'Board_20260930'), 'D:/PCB_Out/Board_20260930');

	// 7.9 dirnameOf：旧版客户端「选文件 → 用其所在目录」的降级方案依赖它
	eq('取 Windows 路径所在目录', dirnameOf('D:\\PCB_Out\\any.txt'), 'D:\\PCB_Out');
	eq('取正斜杠路径所在目录', dirnameOf('D:/PCB_Out/any.txt'), 'D:/PCB_Out');
	eq('盘符根保持绝对路径', dirnameOf('C:\\a.txt'), 'C:\\');
	eq('无目录部分返回空', dirnameOf('a.txt'), '');
	eq('空输入返回空', dirnameOf(''), '');

	// ================= 8. 运行时能力探测 =================
	console.log('\n[8] 运行时能力探测（capabilities）');

	/**
	 * 临时替换全局 `eda` 后重新探测。
	 * 这是本模块唯一可靠的测试方式：能力探测的意义就在于「问运行时」。
	 */
	const withFakeEda = <T>(value: unknown, run: () => T): T => {
		const g = globalThis as unknown as { eda?: unknown };
		const prev = g.eda;
		g.eda = value;
		invalidateCapabilities();
		try {
			return run();
		}
		finally {
			g.eda = prev;
			invalidateCapabilities();
		}
	};

	// 8.1 全局 eda 不可用：全部判为缺失，且不抛异常
	withFakeEda(undefined, () => {
		const caps = getCapabilities();
		eq('eda 缺失时全部能力为 false', CAPABILITY_KEYS.every(k => caps[k] === false), true);
		eq('eda 缺失时缺失项数等于清单长度', missingCapabilities().length, CAPABILITY_KEYS.length);
	});

	// 8.2 全部接口齐备
	const fullEda: Record<string, Record<string, unknown>> = {};
	for (const key of CAPABILITY_KEYS) {
		const dot = key.indexOf('.');
		const accessor = key.slice(0, dot);
		const method = key.slice(dot + 1);
		const bucket = fullEda[accessor] ?? (fullEda[accessor] = {});
		bucket[method] = () => {};
	}
	withFakeEda(fullEda, () => {
		eq('全部注入时全部为 true', CAPABILITY_KEYS.every(k => getCapabilities()[k] === true), true);
		eq('全部注入时无缺失项', missingCapabilities().length, 0);
	});

	// 8.3 命名空间是「函数」而非「对象」时也要能探测
	//     （真实运行时类实例是 object，但部分实现会把命名空间暴露成带属性的函数）
	withFakeEda(
		{ sys_FileSystem: Object.assign(() => {}, { saveFileToFileSystem: () => {} }) },
		() => {
			eq('函数型命名空间也能探测到方法', getCapabilities()['sys_FileSystem.saveFileToFileSystem'], true);
		},
	);

	// 8.4 中间层整体缺失
	withFakeEda({ sys_FileSystem: undefined }, () => {
		eq('中间层缺失判为 false', getCapabilities()['sys_FileSystem.saveFileToFileSystem'], false);
	});

	// 8.5 属性存在但不是函数
	withFakeEda({ sys_Dialog: { showSelectDialog: 'not a function' } }, () => {
		eq('非函数属性判为 false', getCapabilities()['sys_Dialog.showSelectDialog'], false);
	});

	// 8.6 还原用户实测场景：EasyEDA Pro 3.2.149（缺 3 个目录管理接口）
	//     这是本轮修复要解决的真实环境。
	withFakeEda(
		{
			sys_FileSystem: {
				getDocumentsPath: () => {},
				saveFileToFileSystem: () => {},
				// createDirectoryInFileSystem（v3.2.166）/ existsPathInFileSystem（v3.2.167）
				// / openReadFolderPathDialog 在该版本上不存在
			},
		},
		() => {
			const missing = missingCapabilities();
			eq('识别出 createDirectoryInFileSystem 缺失', missing.includes('sys_FileSystem.createDirectoryInFileSystem'), true);
			eq('识别出 existsPathInFileSystem 缺失', missing.includes('sys_FileSystem.existsPathInFileSystem'), true);
			eq('识别出 openReadFolderPathDialog 缺失', missing.includes('sys_FileSystem.openReadFolderPathDialog'), true);
			eq('saveFileToFileSystem 仍可用（降级方案的基础）', getCapabilities()['sys_FileSystem.saveFileToFileSystem'], true);
			eq('getDocumentsPath 仍可用（兜底目录的基础）', getCapabilities()['sys_FileSystem.getDocumentsPath'], true);
		},
	);

	// 8.7 版本解析与比较（用于给出准确的升级建议）
	eq('解析 4 段版本号', parseEdaVersion('3.2.149.88089769'), [3, 2, 149]);
	eq('解析 2 段版本号', parseEdaVersion('4.1'), [4, 1, 0]);
	eq('无法解析时返回 undefined', parseEdaVersion('abc'), undefined);
	eq('3.2.149 < 3.2.167', isVersionAtLeast('3.2.149.88089769', '3.2.167'), false);
	eq('3.2.167 >= 3.2.167', isVersionAtLeast('3.2.167', '3.2.167'), true);
	eq('3.2.170 >= 3.2.167', isVersionAtLeast('3.2.170', '3.2.167'), true);
	eq('4.1.13 >= 3.2.167', isVersionAtLeast('4.1.13', '3.2.167'), true);
	eq('无法解析的版本一律判 false', isVersionAtLeast('', '3.2.167'), false);

	// ================= 9. 超时与软调用 =================
	// 这一组针对「点击无反应」的根因：接口存在但永不返回时，
	// try/catch 抓不住挂起，必须靠硬超时把「永久卡死」降级为「有界等待」。
	console.log('\n[9] 超时与软调用（edaCompat）');

	// 9.1 正常路径不改变行为
	eq('withTimeout 透传 Promise 结果', await withTimeout(Promise.resolve(42), 200, 't'), 42);
	eq('withTimeout 也接受同步值', await withTimeout('ok', 200, 't'), 'ok');

	// 9.2 永不返回 → 抛 ApiTimeoutError
	let timeoutError: unknown;
	try {
		await withTimeout(new Promise(() => {}), 40, 'hang');
	}
	catch (error) {
		timeoutError = error;
	}
	check('挂起的 Promise 会抛 ApiTimeoutError', timeoutError instanceof ApiTimeoutError, `实际=${timeoutError instanceof Error ? `${timeoutError.name}: ${timeoutError.message}` : String(timeoutError)}`);
	eq('超时异常携带接口标签', timeoutError instanceof ApiTimeoutError ? timeoutError.label : undefined, 'hang');

	// 9.3 softCall：任何失败都回退默认值，绝不向外抛
	const hanging = (): Promise<never> => new Promise<never>(() => {});
	const throwing = (): never => {
		throw new Error('boom');
	};

	eq('softCall 超时后回退默认值', await softCall('hang', 40, hanging, 'fallback'), 'fallback');
	eq('softCall 抛错后回退默认值', await softCall('boom', 200, throwing, 'fallback'), 'fallback');
	eq('softCall 正常时返回真实值', await softCall('ok', 200, () => Promise.resolve('real'), 'fallback'), 'real');

	// 9.4 attempt：必须区分「接口不可用」与「用户取消」
	eq('attempt 接口抛错 → ok=false', (await attempt('boom', 200, throwing)).ok, false);
	eq('attempt 接口超时 → ok=false', (await attempt('hang', 40, hanging)).ok, false);
	{
		const accepted = await attempt('ok', 200, () => Promise.resolve('D:/Out'));
		eq('attempt 拿到值时 ok=true 且带值', [accepted.ok, accepted.value], [true, 'D:/Out']);
		const cancelled = await attempt('cancel', 200, () => Promise.resolve(undefined));
		eq('attempt 用户取消：ok=true 但无值（不能被误判为接口不可用）', [cancelled.ok, cancelled.value === undefined], [true, true]);
	}

	// ================= 汇总 =================
	console.log(`\n${'='.repeat(52)}`);
	console.log(`PASS: ${passed}   FAIL: ${failures.length}`);
	if (failures.length > 0) {
		console.log('失败项：');
		for (const f of failures)
			console.log(`  - ${f}`);
		process.exitCode = 1;
	}
	else {
		console.log('全部通过 ✅');
	}
	console.log('='.repeat(52));
}

main().catch((error) => {
	console.error('测试运行异常：', error);
	process.exitCode = 1;
});

/**
 * exporters.ts —— 各个导出步骤
 *
 * 核心设计：**每个步骤独立捕获异常**（任务书第十九节）。
 * 任意一步失败都只记录到结果里，绝不抛出、绝不影响已经生成的文件、绝不删除已成功的产物。
 */

import type { TableAnalysis } from './bomCpl';
import type { BomCplCrossCheckResult, CplFilterResult, DrcResult, ProjectFormat, StepResult } from './types';

import { analyzeTable, crossCheckBomToCpl, filterCpl } from './bomCpl';
import { describeError, DOC_TYPE_PDF, EXPORT_API_TIMEOUT_MS, ExportStepError, isUsableFile, logInfo, logWarn, METADATA_TIMEOUT_MS, safeCall, UNIT_MM, withTimeout } from './edaCompat';
import { getFileExtension, pickExtension, writeFileToDir } from './paths';

/** 一个步骤的执行容器：把「成功/失败/异常」统一收敛为 StepResult */
interface StepOutcome<T> { result: StepResult; payload?: T }

function ok(step: string, fileName: string): StepResult {
	return { step, status: 'OK', fileName };
}

function failed(step: string, detail: string): StepResult {
	return { step, status: 'FAILED', detail };
}

/* ------------------------------------------------------------------ *
 * Gerber
 * ------------------------------------------------------------------ */

/**
 * 导出 Gerber。
 * 只传文件名 —— 其余参数交给 EasyEDA 默认值，从而**保持官方生成内容**，不自行重新生成。
 */
export async function exportGerber(dir: string, baseName: string): Promise<StepOutcome<never>> {
	const step = 'Gerber';
	const desiredBase = `${baseName}_Gerber`;

	const call = await safeCall(step, async () =>
		eda.pcb_ManufactureData.getGerberFile(desiredBase));

	if (!call.ok)
		return { result: failed(step, `调用 getGerberFile 失败：${call.error}`) };

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return {
			result: failed(
				step,
				'API 返回 null / 空文件。可能原因：当前 PCB 尚未完成布线或缺少板框，请在 PCB 编辑器内手动执行一次「导出 → Gerber」确认。',
			),
		};
	}

	// 沿用官方返回文件的扩展名（通常是 .zip），取不到时回退 .zip
	const ext = pickExtension(file as File, '.zip');
	const fileName = `${desiredBase}${ext}`;

	try {
		await writeFileToDir(dir, fileName, file as File);
		return { result: ok(step, fileName) };
	}
	catch (error) {
		return { result: failed(step, describeError(error)) };
	}
}

/* ------------------------------------------------------------------ *
 * BOM
 * ------------------------------------------------------------------ */

export interface BomOutcome {
	/** 供后续 CPL 过滤使用的分析结果 */
	analysis?: TableAnalysis;
}

/**
 * 导出 BOM（优先 XLSX）。
 * 同时返回解析结果，供 CPL 过滤复用，避免重复解析。
 */
export async function exportBom(dir: string, baseName: string): Promise<StepOutcome<BomOutcome>> {
	const step = 'BOM';
	const desiredBase = `${baseName}_BOM`;

	const call = await safeCall(step, async () =>
		eda.pcb_ManufactureData.getBomFile(desiredBase, 'xlsx'));

	if (!call.ok)
		return { result: failed(step, `调用 getBomFile 失败：${call.error}`) };

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return {
			result: failed(
				step,
				'API 返回 null / 空文件。请确认当前 PCB 已关联原理图，或在「制造 → 导出 BOM」中能正常导出。',
			),
		};
	}

	const ext = pickExtension(file as File, '.xlsx');
	const fileName = `${desiredBase}${ext}`;

	let written: string;
	try {
		written = await writeFileToDir(dir, fileName, file as File);
		logInfo(`BOM written: ${written}`);
	}
	catch (error) {
		return { result: failed(step, describeError(error)) };
	}

	// 解析 BOM 位号（失败不影响 BOM 文件本身已成功导出）
	let analysis: TableAnalysis | undefined;
	try {
		analysis = await analyzeTable(file as File, fileName);
	}
	catch (error) {
		logWarn(`BOM parsed for CPL filtering failed: ${describeError(error)}`);
	}

	return { result: ok(step, fileName), payload: { analysis } };
}

/* ------------------------------------------------------------------ *
 * CPL / Pick & Place
 * ------------------------------------------------------------------ */

export interface CplOutcome {
	/** 过滤后的统计（未启用过滤时为 executed=false） */
	filterResult: CplFilterResult;
	/** 反向检查（BOM 有而 CPL 无） */
	crossCheck: BomCplCrossCheckResult;
}

/**
 * 导出 Pick & Place / CPL，并按需依据 BOM 过滤。
 *
 * 单位固定为 **毫米**（JLCPCB 等贴片厂要求 mm）。
 */
export async function exportCpl(
	dir: string,
	baseName: string,
	bomAnalysis: TableAnalysis | undefined,
	filterEnabled: boolean,
): Promise<StepOutcome<CplOutcome>> {
	const step = 'CPL';
	const desiredBase = `${baseName}_CPL`;

	const emptyFilter: CplFilterResult = {
		executed: false,
		originalCount: 0,
		finalCount: 0,
		removedCount: 0,
		removedDesignators: [],
	};
	const emptyCross: BomCplCrossCheckResult = { missingInCpl: [] };

	const call = await safeCall(step, async () =>
		eda.pcb_ManufactureData.getPickAndPlaceFile(desiredBase, 'xlsx', UNIT_MM));

	if (!call.ok) {
		return {
			result: failed(step, `调用 getPickAndPlaceFile 失败：${call.error}`),
			payload: { filterResult: emptyFilter, crossCheck: emptyCross },
		};
	}

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return {
			result: failed(
				step,
				'API 返回 null / 空文件。请确认 PCB 上已有器件，且器件的「转坐标文件」属性未被全部关闭。',
			),
			payload: { filterResult: emptyFilter, crossCheck: emptyCross },
		};
	}

	const ext = pickExtension(file as File, '.xlsx');
	const fileName = `${desiredBase}${ext}`;

	// ---------- 未启用过滤：原样导出 ----------
	if (!filterEnabled) {
		try {
			await writeFileToDir(dir, fileName, file as File);
			return {
				result: ok(step, fileName),
				payload: {
					filterResult: { ...emptyFilter, reason: '用户未勾选「删除 CPL 中 BOM 不存在的元件」，已原样导出。' },
					crossCheck: emptyCross,
				},
			};
		}
		catch (error) {
			return {
				result: failed(step, describeError(error)),
				payload: { filterResult: emptyFilter, crossCheck: emptyCross },
			};
		}
	}

	// ---------- 启用过滤 ----------
	// 前置条件：BOM 必须先成功导出并可解析
	if (!bomAnalysis) {
		try {
			await writeFileToDir(dir, fileName, file as File);
			return {
				result: ok(step, fileName),
				payload: {
					filterResult: {
						...emptyFilter,
						reason: 'BOM 未能成功导出或无法解析位号列，已跳过过滤并导出原始 CPL（未修改任何数据）。',
					},
					crossCheck: emptyCross,
				},
			};
		}
		catch (error) {
			return {
				result: failed(step, describeError(error)),
				payload: { filterResult: emptyFilter, crossCheck: emptyCross },
			};
		}
	}

	let cplAnalysis: TableAnalysis;
	try {
		cplAnalysis = await analyzeTable(file as File, fileName);
	}
	catch (error) {
		// 解析失败：保留原始 CPL，明确报告未过滤原因
		const detail = describeError(error);
		logWarn(`[CPL] analyze failed: ${detail}`);
		try {
			await writeFileToDir(dir, fileName, file as File);
			return {
				result: ok(step, fileName),
				payload: {
					filterResult: {
						...emptyFilter,
						reason: `无法解析 CPL 位号列，已导出原始 CPL（未修改）。原因：${detail}`,
					},
					crossCheck: emptyCross,
				},
			};
		}
		catch (writeError) {
			return {
				result: failed(step, describeError(writeError)),
				payload: { filterResult: emptyFilter, crossCheck: emptyCross },
			};
		}
	}

	let filtered: Awaited<ReturnType<typeof filterCpl>>;
	try {
		filtered = await filterCpl(cplAnalysis, bomAnalysis.designators, fileName);
	}
	catch (error) {
		const detail = describeError(error);
		logWarn(`[CPL] filter failed: ${detail}`);
		try {
			await writeFileToDir(dir, fileName, file as File);
			return {
				result: ok(step, fileName),
				payload: {
					filterResult: { ...emptyFilter, reason: `过滤过程异常，已导出原始 CPL（未修改）。原因：${detail}` },
					crossCheck: emptyCross,
				},
			};
		}
		catch (writeError) {
			return {
				result: failed(step, describeError(writeError)),
				payload: { filterResult: emptyFilter, crossCheck: emptyCross },
			};
		}
	}

	try {
		await writeFileToDir(dir, filtered.fileName, filtered.blob);
	}
	catch (error) {
		return {
			result: failed(step, describeError(error)),
			payload: { filterResult: filtered.result, crossCheck: emptyCross },
		};
	}

	const cross = crossCheckBomToCpl(bomAnalysis.designators, cplAnalysis.designators);

	return {
		result: ok(step, filtered.fileName),
		payload: { filterResult: filtered.result, crossCheck: cross },
	};
}

/* ------------------------------------------------------------------ *
 * 交互式 BOM（HTML）
 * ------------------------------------------------------------------ */

/**
 * 当前官方 API 是否提供交互式 BOM 导出。
 *
 * 已核实：`eda.pcb_ManufactureData.getInteractiveBomFile(fileName?)` 存在于
 * `@jlceda/pro-api-types@0.4.25`，返回 `Promise<File | undefined>`。
 */
export const IS_INTERACTIVE_BOM_SUPPORTED = true;

/**
 * 导出交互式 BOM（HTML）。
 *
 * 官方接口 `getInteractiveBomFile` 在类型定义中标注为 **`@internal`**：
 * 它**确实存在且可调用**，但官方未承诺其跨版本稳定性（未来可能改名或改签名）。
 * 因此这里：
 *   - 独立 try/catch，失败不影响任何其它交付文件；
 *   - 在报告与完成窗口中**如实标注**该接口属于 `@internal`，而不是假装它和公开接口一样稳。
 */
export async function exportInteractiveBom(dir: string, baseName: string): Promise<StepOutcome<never>> {
	const step = 'iBOM';
	const desiredBase = `${baseName}_iBOM`;

	const call = await safeCall(step, async () =>
		eda.pcb_ManufactureData.getInteractiveBomFile(desiredBase));

	if (!call.ok)
		return { result: failed(step, `调用 getInteractiveBomFile 失败：${call.error}`) };

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return {
			result: failed(
				step,
				'API 返回 null / 空文件。请确认当前 PCB 已关联 BOM 数据（器件需具备位号与封装信息）。',
			),
		};
	}

	// 沿用官方返回文件的扩展名（通常是 .html），取不到时回退 .html
	const ext = pickExtension(file as File, '.html');
	const fileName = `${desiredBase}${ext}`;

	try {
		await writeFileToDir(dir, fileName, file as File);
		return {
			result: {
				step,
				status: 'OK',
				fileName,
				detail: '来源：官方 getInteractiveBomFile（语言跟随 EasyEDA 当前界面语言；该接口标注为 @internal）。',
			},
		};
	}
	catch (error) {
		return { result: failed(step, describeError(error)) };
	}
}

/* ------------------------------------------------------------------ *
 * 原理图 PDF
 * ------------------------------------------------------------------ */

/** EDMT_EditorDocumentType.SCHEMATIC_PAGE === 1 */
const DOC_TYPE_SCHEMATIC_PAGE = 1 as EDMT_EditorDocumentType.SCHEMATIC_PAGE;

/**
 * 导出全部原理图为**单个合并 PDF**。
 *
 * 使用 `sch_ManufactureData.getExportDocumentFile` 的
 * `object='All Schematic'` + `outputMethod='Merged sheet'` + `range='All'`，
 * 由 EasyEDA 自身完成合并，**不逐页导出后再自行拼接**。
 *
 * 若当前焦点不在原理图上，则先打开首个原理图图页再导出，导出后恢复原标签页。
 * 该降级过程**不会修改任何设计数据**。
 */
export async function exportSchematicPdf(dir: string, baseName: string): Promise<StepOutcome<never>> {
	const step = 'Schematic PDF';
	const fileName = `${baseName}_Schematic.pdf`;

	const runExport = async (): Promise<File | undefined> => {
		return eda.sch_ManufactureData.getExportDocumentFile(
			`${baseName}_Schematic`,
			DOC_TYPE_PDF,
			{
				theme: 'Default',
				lineWidth: 'Default',
				displayAttributesAsMenu: false,
				size: 'Original Size',
			},
			'All Schematic',
			{ range: 'All', outputMethod: 'Merged sheet' },
		);
	};

	// 1) 记录当前文档，便于失败时恢复
	let originalTabId: string | undefined;
	try {
		const current = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo(), METADATA_TIMEOUT_MS, 'getCurrentDocumentInfo(PDF)');
		originalTabId = current?.tabId;
	}
	catch {
		/* ignore */
	}

	// 2) 首次尝试（当前上下文可能已可用）
	let call = await safeCall(step, runExport);

	// 3) 若首次失败且当前不在原理图页，则切到首个原理图页重试
	if ((!call.ok || !(await isUsableFile(call.value))) && !(await isInSchematicContext())) {
		const switched = await tryOpenFirstSchematicPage();
		if (switched) {
			logInfo('Schematic context switched for PDF export, retrying...');
			call = await safeCall(step, runExport);
		}
	}

	// 4) 恢复原标签页（无论成败）
	if (originalTabId) {
		try {
			await withTimeout(eda.dmt_EditorControl.activateDocument(originalTabId), METADATA_TIMEOUT_MS, 'activateDocument(restore)');
		}
		catch {
			/* 恢复失败不影响导出结果 */
		}
	}

	if (!call.ok)
		return { result: failed(step, `导出失败：${call.error}`) };

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return {
			result: failed(
				step,
				'API 返回 null / 空文件。请确认工程内存在原理图，且当前版本支持「导出 → 原理图 PDF」。',
			),
		};
	}

	try {
		await writeFileToDir(dir, fileName, file as File);
		return { result: ok(step, fileName) };
	}
	catch (error) {
		return { result: failed(step, describeError(error)) };
	}
}

/** 当前焦点是否在原理图页上 */
async function isInSchematicContext(): Promise<boolean> {
	try {
		const current = await withTimeout(eda.dmt_SelectControl.getCurrentDocumentInfo(), METADATA_TIMEOUT_MS, 'getCurrentDocumentInfo(schematic)');
		return current?.documentType === DOC_TYPE_SCHEMATIC_PAGE;
	}
	catch {
		return false;
	}
}

/** 打开工程内第一个原理图图页；成功返回 true */
async function tryOpenFirstSchematicPage(): Promise<boolean> {
	try {
		const pages = await withTimeout(eda.dmt_Schematic.getAllSchematicPagesInfo(), METADATA_TIMEOUT_MS, 'getAllSchematicPagesInfo');
		if (!Array.isArray(pages) || pages.length === 0)
			return false;

		const tabId = await withTimeout(eda.dmt_EditorControl.openDocument(pages[0].uuid), METADATA_TIMEOUT_MS, 'openDocument(schematic)');
		if (!tabId)
			return false;

		await withTimeout(eda.dmt_EditorControl.activateDocument(tabId), METADATA_TIMEOUT_MS, 'activateDocument(schematic)');
		return true;
	}
	catch (error) {
		logWarn(`tryOpenFirstSchematicPage failed: ${describeError(error)}`);
		return false;
	}
}

/* ------------------------------------------------------------------ *
 * STEP
 * ------------------------------------------------------------------ */

/**
 * 导出 STEP。
 *
 * - `modelMode: 'Outfit'`（装配体），与 EasyEDA 自身「导出 3D 模型」默认一致。
 * - `autoGenerateModels: false` —— **不为缺少 3D 模型的元件伪造几何体**，
 *   避免交付文件与真实模型不符；缺少模型的元件不会阻断导出。
 */
export async function exportStep(dir: string, baseName: string): Promise<StepOutcome<never>> {
	const step = 'STEP';
	const fileName = `${baseName}.step`;

	const call = await safeCall(step, async () =>
		eda.pcb_ManufactureData.get3DFile(baseName, 'step', undefined, 'Outfit', false));

	if (!call.ok)
		return { result: failed(step, `调用 get3DFile 失败：${call.error}`) };

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return {
			result: failed(
				step,
				'API 返回 null / 空文件。请注意：只有以 STEP 格式导入的元件模型才会体现在导出的 STEP 中。',
			),
		};
	}

	try {
		await writeFileToDir(dir, fileName, file as File);
		return { result: ok(step, fileName) };
	}
	catch (error) {
		return { result: failed(step, describeError(error)) };
	}
}

/* ------------------------------------------------------------------ *
 * 3D HTML（官方 API 不支持）
 * ------------------------------------------------------------------ */

/**
 * 3D HTML 导出占位。
 *
 * 经全量核实（API_NOTES.md 第八节）：当前官方 Extension API **不提供** 3D HTML 导出。
 * `get3DFile` 仅支持 `'step' | 'obj'`，`get3DShellFile` 仅支持 `'stl' | 'step' | 'obj'`。
 * 因此本函数**不伪造任何 HTML**，仅返回 NOT SUPPORTED。
 *
 * 官方开放该能力后，在此处接入即可（UI 与报告会自动跟随）。
 */
export async function export3DHtml(): Promise<StepOutcome<never>> {
	return {
		result: {
			step: '3D HTML',
			status: 'NOT SUPPORTED',
			detail: '当前 EasyEDA Extension API 未提供 3D HTML 导出接口（get3DFile 仅支持 step / obj）。',
		},
	};
}

/** 当前官方 API 是否支持 3D HTML 导出。UI 用它决定是否禁用勾选项。 */
export const IS_3D_HTML_SUPPORTED = false;

/* ------------------------------------------------------------------ *
 * 工程源文件
 * ------------------------------------------------------------------ */

/** 工程格式 → 官方 fileType（已核实：V3 → epro2，V2 → epro） */
export function projectFormatToFileType(format: ProjectFormat): 'epro' | 'epro2' {
	return format === 'V2' ? 'epro' : 'epro2';
}

/** 工程格式 → 默认扩展名 */
export function projectFormatToExtension(format: ProjectFormat): string {
	return format === 'V2' ? '.epro' : '.epro2';
}

/**
 * 导出 EasyEDA 工程源文件。
 *
 * 使用 `eda.sys_FileManager.getProjectFile`（**不是** `DMT_Project`，后者无此方法）。
 * 需要用户在 **工程管理 → 下载工程** 拥有权限，否则官方 API 会 `throw Error`。
 */
export async function exportProject(
	dir: string,
	baseName: string,
	format: ProjectFormat,
): Promise<StepOutcome<never>> {
	const step = `Project ${format}`;
	const fileType = projectFormatToFileType(format);
	const fallbackExt = projectFormatToExtension(format);

	const call = await safeCall(step, async () =>
		eda.sys_FileManager.getProjectFile(baseName, undefined, fileType));

	if (!call.ok) {
		return {
			result: failed(
				step,
				`调用 getProjectFile 失败：${call.error}\n`
				+ '该接口需要拥有「工程管理 → 下载工程」权限；如为权限问题，请在 EDA 中确认账号权限后重试。',
			),
		};
	}

	const file = call.value;
	if (!(await isUsableFile(file))) {
		return { result: failed(step, 'API 返回 null / 空文件，工程数据获取失败。') };
	}

	// 官方返回的文件扩展名可能与预期不同（例如请求 epro2 却得到 epro），以实际为准
	const actualExt = getFileExtension(file as File);
	const ext = actualExt || fallbackExt;
	const fileName = `${baseName}${ext}`;

	try {
		await writeFileToDir(dir, fileName, file as File);

		// 扩展名与用户所选格式不一致时，明确提示而不是静默
		if (actualExt && actualExt !== fallbackExt) {
			return {
				result: {
					step,
					status: 'OK',
					fileName,
					detail: `注意：请求格式为 ${fallbackExt}，实际返回 ${actualExt}，已按实际扩展名保存。`,
				},
			};
		}

		return { result: ok(step, fileName) };
	}
	catch (error) {
		return { result: failed(step, describeError(error)) };
	}
}

/* ------------------------------------------------------------------ *
 * DRC
 * ------------------------------------------------------------------ */

/**
 * 运行 PCB DRC。
 *
 * 官方返回值是**结构未公开**的 `Array<any>`，因此这里做**防御式分析**：
 * 只在能明确识别字段时才给出 Errors / Unrouted 计数，
 * 无法识别时只报告条目总数，并把原始结果（截断）写入报告供人工核对。
 * **不臆造** Errors / Unrouted 字段。
 */
export async function runDrcCheck(): Promise<DrcResult> {
	const step = 'DRC';

	let raw: unknown;
	try {
		// strict = true（官方备注：当前 PCB 统一为严格检查模式）
		// userInterface = false（批量导出不主动呼出底部面板）
		// includeVerboseError = true（获取详细结果）
		raw = await withTimeout(eda.pcb_Drc.check(true, false, true), EXPORT_API_TIMEOUT_MS, 'pcb_Drc.check');
	}
	catch (error) {
		const message = describeError(error);
		logWarn(`[${step}] check threw: ${message}`);
		return {
			executed: false,
			passed: false,
			itemCount: 0,
			error: message,
		};
	}

	const analysis = analyzeDrcResult(raw);
	const passed = analysis.itemCount === 0;
	logInfo(`[${step}] items=${analysis.itemCount} passed=${passed}`);

	return {
		executed: true,
		passed,
		itemCount: analysis.itemCount,
		errorCount: analysis.errorCount,
		unroutedCount: analysis.unroutedCount,
		rawSummary: analysis.rawSummary,
	};
}

interface DrcAnalysis {
	itemCount: number;
	errorCount?: number;
	unroutedCount?: number;
	rawSummary?: string;
}

const ERROR_KEYWORDS = ['error', '错误', 'violation', 'fail', 'short', 'clearance'];
const UNROUTED_KEYWORDS = ['unrout', '未布', '飞线', 'ratsnest', 'missing connection'];

/** 在对象的字符串字段里寻找严重级别 / 类别信息 */
function classifyItem(item: unknown): 'error' | 'unrouted' | 'unknown' {
	if (item === null || item === undefined)
		return 'unknown';

	if (typeof item === 'string') {
		const lower = item.toLowerCase();
		if (UNROUTED_KEYWORDS.some(k => lower.includes(k)))
			return 'unrouted';
		if (ERROR_KEYWORDS.some(k => lower.includes(k)))
			return 'error';
		return 'unknown';
	}

	if (typeof item !== 'object')
		return 'unknown';

	const record = item as Record<string, unknown>;
	const fieldsToScan = ['severity', 'level', 'type', 'category', 'errorType', 'rule', 'ruleName', 'message', 'name', 'title'];

	let sawError = false;
	for (const field of fieldsToScan) {
		const value = record[field];
		if (typeof value !== 'string')
			continue;
		const lower = value.toLowerCase();
		if (UNROUTED_KEYWORDS.some(k => lower.includes(k)))
			return 'unrouted';
		if (ERROR_KEYWORDS.some(k => lower.includes(k)))
			sawError = true;
	}

	return sawError ? 'error' : 'unknown';
}

/** 防御式分析 DRC 返回值 */
function analyzeDrcResult(raw: unknown): DrcAnalysis {
	// 官方在 includeVerboseError=true 时返回数组；但留一手以防返回布尔
	if (typeof raw === 'boolean')
		return { itemCount: raw ? 0 : 1 };

	if (!Array.isArray(raw)) {
		return {
			itemCount: raw === undefined || raw === null ? 0 : 1,
			rawSummary: safeJson(raw),
		};
	}

	// 空数组 = 通过
	if (raw.length === 0)
		return { itemCount: 0 };

	// 部分实现会返回 [ok, details] 这种二元结构，做一次解包
	let items: unknown[] = raw;
	if (raw.length === 2 && typeof raw[0] === 'boolean' && Array.isArray(raw[1])) {
		if (raw[0] === true)
			return { itemCount: 0 };
		items = raw[1] as unknown[];
	}

	let errorCount = 0;
	let unroutedCount = 0;
	let unknownCount = 0;

	for (const item of items) {
		switch (classifyItem(item)) {
			case 'error':
				errorCount++;
				break;
			case 'unrouted':
				unroutedCount++;
				break;
			default:
				unknownCount++;
				break;
		}
	}

	const analysis: DrcAnalysis = {
		itemCount: items.length,
		// 仅当归类结果「干净」（无未知项）时才给出确定的分项计数，避免误导
		rawSummary: safeJson(items),
	};

	if (unknownCount === 0) {
		analysis.errorCount = errorCount;
		analysis.unroutedCount = unroutedCount;
	}

	return analysis;
}

/** 安全 JSON 化并截断，用于写入报告 */
function safeJson(value: unknown): string | undefined {
	try {
		const text = JSON.stringify(value);
		if (text === undefined)
			return undefined;
		return text.length > 4000 ? `${text.slice(0, 4000)}…(truncated)` : text;
	}
	catch {
		return undefined;
	}
}

/** 供 index.ts 使用的导出步骤错误包装（保证类型可用） */
export { ExportStepError };

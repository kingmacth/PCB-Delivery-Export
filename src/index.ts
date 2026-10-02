/**
 * index.ts —— PCB Delivery Export 插件入口
 *
 * 菜单注册：`extension.json` → `headerMenus.pcb[0].menuItems[0].registerFn = "exportDeliveryPackage"`
 *
 * 主流程：
 *   1. 校验当前已打开 PCB 文档（否则提示「请先打开 PCB 文档。」并且**不执行任何导出**）
 *   2. 运行时前置检查（本地文件系统写入能力 / 客户端环境）
 *   3. 弹出配置界面（官方弹窗，回调链，用户取消时链条自然终止）
 *   4. 保存设置 → 创建 `板名_YYYYMMDD` 目录（已存在则递增 _02、_03 …）
 *   5. 依次执行各导出步骤，**每步独立 try/catch**
 *   6. 写出 Export_Report.txt
 *   7. 展示完成窗口
 *
 * 不做的事（任务书第二十六节）：不伪造 API、不模拟鼠标点击、不修改用户 PCB / BOM 设置、
 * 不删除 DNP 器件、不覆盖历史导出目录、不因单点失败中断整体、不静默删行、不谎称支持 3D HTML。
 */

import type { TableAnalysis } from './bomCpl';

import type { DeliverySettings, ExportRunResult, StepResult } from './types';
import extensionConfig from '../extension.json' with { type: 'json' };

import { can, CAPABILITY_META, missingCapabilities, versionAdvice } from './capabilities';
import {
	describeError,
	logError,
	logInfo,
	logWarn,
	METADATA_TIMEOUT_MS,
	softCall,
	withTimeout,
} from './edaCompat';
import {
	export3DHtml,
	exportBom,
	exportCpl,
	exportGerber,
	exportInteractiveBom,
	exportProject,
	exportSchematicPdf,
	exportStep,
	runDrcCheck,
} from './exporters';
import { t } from './i18n';
import { buildManufacturingRequirements, buildRequirementsBlob, REQUIREMENTS_FILE_EN, REQUIREMENTS_FILE_ZH, requirementsFromSettings } from './manufacturing';
import { notifyError } from './notify';
import { createDeliveryDirectory, formatLocalDateTime, sanitizeName, validateBaseDir, writeFileToDir } from './paths';
import { buildReportBlob, REPORT_FILE_NAME } from './report';
import { loadSettings, saveSettings } from './settings';
import {
	confirmDrcFailure,
	finishExportProgress,
	isPcbDocumentOpen,
	setExportProgress,
	showCompletion,
	showInfo,
	showNoPcbMessage,
	startConfigFlow,
} from './ui';

/** 插件版本（取自 extension.json） */
const PLUGIN_VERSION: string = extensionConfig.version ?? '1.0.0';

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/** 扩展激活回调（SDK 约定的入口导出） */
export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	// 只写 EDA 日志面板，不弹窗打扰用户
	logInfo(`v${PLUGIN_VERSION} activated.`);
}

/* ------------------------------------------------------------------ *
 * 菜单入口
 * ------------------------------------------------------------------ */

/**
 * 菜单回调：PCB Delivery → Export Delivery Package / 一键导出
 *
 * ## 关键改动（针对「点击无反应」）
 *
 * 旧实现是「先 `await` 一串前置检查，再弹配置窗口」：
 *
 *     await isPcbDocumentOpen();
 *     startConfigFlow(...);            // ← 前面任何一步挂起，这里就永远执行不到
 *
 * 在旧版客户端上这会导致**点击后完全没有任何可见反应**。
 * 现在每一次前置查询都套上**硬超时**，且超时一律按「检查通过」继续 ——
 * 宁可让后续步骤给出具体错误，也绝不把用户挡在一个看不见的门外面。
 */
export function exportDeliveryPackage(): void {
	void runEntry();
}

async function runEntry(): Promise<void> {
	try {
		// 配置窗口必须是菜单点击后的第一个动作。任何官方查询即使有超时，
		// 也不能挡在窗口前面，否则用户看到的仍会是“点了没反应”。
		const settings = loadSettings();

		startConfigFlow(settings, ({ settings: finalSettings, dirSource }) => {
			void (async () => {
				setExportProgress(2, t('正在检查当前 PCB 文档…'));
				const pcbOpen = await softCall(
					'dmt_SelectControl.getCurrentDocumentInfo',
					METADATA_TIMEOUT_MS,
					() => isPcbDocumentOpen(),
					true,
				);
				if (pcbOpen === false) {
					finishExportProgress(t('未打开 PCB，导出已停止。'));
					showNoPcbMessage();
					return;
				}
				// 设置在**导出开始前**就落盘：即便后续任一步失败/被取消，
				// 用户本次勾选的内容与目录也应被记住（真实反馈：「选项没有保存」）。
				const saved = await saveSettings(finalSettings);
				if (!saved)
					logWarn('设置未能写入持久化存储；本次导出仍会继续，但选择不会被记住。');
				await runDelivery(finalSettings, dirSource);
			})();
		});
	}
	catch (error) {
		const message = describeError(error);
		logError(`[Export] unexpected failure: ${message}`);
		// notify 永不抛出，因此这一层一定能被用户看到
		notifyError(
			`${t('插件执行出现未预期的错误：')}\n${message}`,
			t('PCB Delivery Export'),
		);
	}
}

/* ------------------------------------------------------------------ *
 * 主导出流程
 * ------------------------------------------------------------------ */

/**
 * 取当前 PCB 所属的板名。
 *
 * 一个工程可以包含多块板，所以交付文件不能再用工程名命名。
 * 未关联到“板子”的独立 PCB 没有 board name，此时使用 PCB 文档名；
 * 旧客户端若缺少相关接口，最后才回退到工程名。
 */
async function resolveCurrentBoardName(): Promise<string> {
	if (can('dmt_Board.getCurrentBoardInfo')) {
		try {
			const board = await withTimeout(
				eda.dmt_Board.getCurrentBoardInfo(),
				METADATA_TIMEOUT_MS,
				'dmt_Board.getCurrentBoardInfo',
			);
			if (board?.name?.trim())
				return board.name.trim();
		}
		catch (error) {
			logWarn(`无法读取当前板子信息：${describeError(error)}`);
		}
	}

	if (can('dmt_SelectControl.getCurrentDocumentInfo') && can('dmt_Pcb.getPcbInfo')) {
		try {
			const document = await withTimeout(
				eda.dmt_SelectControl.getCurrentDocumentInfo(),
				METADATA_TIMEOUT_MS,
				'dmt_SelectControl.getCurrentDocumentInfo(board name)',
			);
			if (document?.documentType === 3 && document.uuid) {
				const pcb = await withTimeout(
					eda.dmt_Pcb.getPcbInfo(document.uuid),
					METADATA_TIMEOUT_MS,
					'dmt_Pcb.getPcbInfo',
				);
				const pcbName = pcb?.parentBoardName || pcb?.name;
				if (pcbName?.trim())
					return pcbName.trim();
			}
		}
		catch (error) {
			logWarn(`无法读取当前 PCB 名称：${describeError(error)}`);
		}
	}

	try {
		const projectInfo = await withTimeout(
			eda.dmt_Project.getCurrentProjectInfo(),
			METADATA_TIMEOUT_MS,
			'dmt_Project.getCurrentProjectInfo(board-name fallback)',
		);
		return projectInfo?.friendlyName?.trim() || projectInfo?.name?.trim() || 'PCB_Board';
	}
	catch (error) {
		logWarn(`无法读取工程名回退值：${describeError(error)}`);
		return 'PCB_Board';
	}
}

async function runDelivery(settings: DeliverySettings, dirSource: string): Promise<void> {
	// ---------- 至少勾选一项 ----------
	if (!hasAnyStep(settings)) {
		finishExportProgress(t('没有可导出的项目。'));
		showInfo(t('未勾选任何导出内容，已取消。'), t('PCB Delivery Export'));
		return;
	}

	// ---------- 校验输出目录 ----------
	if (validateBaseDir(settings.outputDir)) {
		finishExportProgress(t('输出目录无效。'));
		showInfo(
			`${t('输出目录无效：')}${settings.outputDir || t('(空)')}\n\n${
				t('请重新选择输出目录。目录必须为绝对路径，例如 D:\\PCB_Output')}`,
			t('PCB Delivery Export'),
		);
		return;
	}

	// ---------- 持久化设置 ----------
	// （已上移到配置回调中：设置先落盘，再开始导出）

	const run: ExportRunResult = {
		boardName: '',
		exportDate: formatLocalDateTime(new Date()),
		edaVersion: readEdaVersion(),
		pluginVersion: PLUGIN_VERSION,
		outputDir: '',
		steps: [],
		cplFilter: {
			executed: false,
			originalCount: 0,
			finalCount: 0,
			removedCount: 0,
			removedDesignators: [],
		},
		crossCheck: { missingInCpl: [] },
		drc: { executed: false, passed: true, itemCount: 0 },
		environmentNotes: collectEnvironmentNotes(dirSource),
		warnings: [],
		criticalNotes: [],
		manufacturingRequirements: requirementsFromSettings(settings),
	};

	let targetDir = '';
	let reportFileName = REPORT_FILE_NAME;
	let bomAnalysis: TableAnalysis | undefined;

	try {
		// ---------- 当前板名 ----------
		const rawName = await resolveCurrentBoardName();
		const boardName = sanitizeName(rawName);
		run.boardName = boardName;

		if (boardName !== rawName) {
			run.warnings.push(
				`${t('板名包含不合法字符，已清洗：')}"${rawName}" → "${boardName}"`,
			);
		}

		// ---------- 创建日期版本目录 ----------
		setExportProgress(8, t('正在准备输出目录…'));
		const staged = await createDeliveryDirectory(settings.outputDir, boardName);
		targetDir = staged.fullPath;
		reportFileName = staged.reportFileName;
		run.outputDir = staged.fullPath;
		run.environmentNotes.push(`目录版本号判定策略: ${staged.strategy}`);
		run.environmentNotes.push(...staged.notes);
		for (const note of staged.notes)
			run.warnings.push(note);
		// 输出目录被改写 / 平铺降级这类「结果不符合预期」的说明，
		// 必须在完成窗口顶部原样显示，不能只留在报告里。
		for (const note of staged.critical) {
			run.warnings.push(note);
			run.criticalNotes.push(note);
		}

		/**
		 * 交付文件的命名前缀。
		 *
		 * 正常模式 = 板名（文件都落在 `板名_YYYYMMDD\` 子目录里，无需在文件名上再带日期）；
		 * 平铺降级模式 = `板名_YYYYMMDD`（子目录建不出来时，只能靠文件名区分不同日期的导出）。
		 */
		const filePrefix = staged.filePrefix || boardName;
		const requirementsText = buildManufacturingRequirements(run.manufacturingRequirements, boardName, run.exportDate);

		// ---------- 制造要求：双语内容、双文件名，避免任一语言客户忽略 ----------
		setExportProgress(16, t('正在写入制造要求…'));
		const requirementFileNames = (filePrefix === boardName)
			? [REQUIREMENTS_FILE_ZH, REQUIREMENTS_FILE_EN]
			: [`${filePrefix}_制造要求_请先阅读.txt`, `${filePrefix}_FABRICATION_REQUIREMENTS_READ_FIRST.txt`];
		for (const fileName of requirementFileNames) {
			run.steps.push(await guard('Fabrication Requirements', async () => {
				await writeFileToDir(targetDir, fileName, buildRequirementsBlob(requirementsText));
				return { result: { step: 'Fabrication Requirements', status: 'OK' as const, fileName } };
			}));
		}
		run.criticalNotes.push('制造要求已写入双语提醒文件及 Gerber ZIP；提交生产前仍须在下单页面逐项确认。 / Verify all fabrication options on the order page before production.');

		// ---------- DRC ----------
		if (settings.runDrc) {
			setExportProgress(14, t('正在运行 DRC…'));
			run.drc = await runDrcCheck();

			if (!run.drc.executed) {
				run.warnings.push(`DRC ${t('未执行')}: ${run.drc.error ?? t('未知原因')}`);
			}
			else if (!run.drc.passed) {
				// 不强制禁止导出：某些项目存在工程师已明确接受的 DRC 警告
				const proceed = await confirmDrcFailure(run.drc);
				if (!proceed) {
					finishExportProgress(t('已取消导出。'));
					showInfo(
						`${t('已按你的选择取消本次导出。')}\n\n`
						+ `${t('未生成任何交付文件。目录可能已创建但仍为空：')}\n${targetDir}`,
						t('PCB Delivery Export'),
					);
					return;
				}
			}
		}

		// ---------- 制造文件：Gerber ----------
		if (settings.exportGerber) {
			setExportProgress(22, t('正在导出 Gerber…'));
			run.steps.push(await guard('Gerber', () => exportGerber(targetDir, filePrefix, requirementsText)));
		}

		// ---------- 制造文件：BOM ----------
		if (settings.exportBom) {
			setExportProgress(36, t('正在导出 BOM…'));
			const outcome = await guardWithPayload('BOM', () => exportBom(targetDir, filePrefix));
			run.steps.push(outcome.result);
			bomAnalysis = outcome.payload?.analysis;
		}

		// ---------- 制造文件：CPL（含按 BOM 过滤） ----------
		if (settings.exportCpl) {
			setExportProgress(50, t('正在导出 CPL 并按 BOM 过滤…'));
			const outcome = await guardWithPayload(
				'CPL',
				() => exportCpl(targetDir, filePrefix, bomAnalysis, settings.cplFilterEnabled),
			);
			run.steps.push(outcome.result);

			if (outcome.payload) {
				run.cplFilter = outcome.payload.filterResult;
				run.crossCheck = outcome.payload.crossCheck;
			}
		}

		// ---------- 设计文档：原理图 PDF ----------
		if (settings.exportSchematicPdf) {
			setExportProgress(62, t('正在导出原理图 PDF…'));
			run.steps.push(await guard('Schematic PDF', () => exportSchematicPdf(targetDir, filePrefix)));
		}

		// ---------- 设计文档：STEP ----------
		if (settings.exportStep) {
			setExportProgress(72, t('正在导出 STEP…'));
			run.steps.push(await guard('STEP', () => exportStep(targetDir, filePrefix)));
		}

		// ---------- 设计文档：交互式 BOM（HTML） ----------
		if (settings.exportInteractiveBom) {
			setExportProgress(80, t('正在导出交互式 BOM…'));
			run.steps.push(await guard('iBOM', () => exportInteractiveBom(targetDir, filePrefix)));
		}

		// ---------- 3D HTML：官方 API 不支持，恒定记录为 NOT SUPPORTED（不伪造） ----------
		run.steps.push(await guard('3D HTML', async () => export3DHtml()));

		// ---------- 工程源文件：V3 / V2 各自独立勾选，互不影响 ----------
		if (settings.exportProjectV3) {
			setExportProgress(88, t('正在导出工程源文件 V3 (.epro2)…'));
			run.steps.push(
				await guard('Project V3', () => exportProject(targetDir, filePrefix, 'V3')),
			);
		}

		if (settings.exportProjectV2) {
			setExportProgress(92, t('正在导出工程源文件 V2 (.epro)…'));
			run.steps.push(
				await guard('Project V2', () => exportProject(targetDir, filePrefix, 'V2')),
			);
		}
	}
	catch (error) {
		// 目录创建失败 / 工程信息获取失败等属于致命错误：此时无法继续写任何交付文件
		const message = describeError(error);
		logError(`[Export] fatal: ${message}`);
		run.fatalError = message;
	}

	// ---------- 汇总警告 ----------
	for (const step of run.steps) {
		if (step.status === 'FAILED')
			run.warnings.push(`${step.step} ${t('导出失败')}: ${step.detail ?? t('(无详情)')}`);
		else if (step.status === 'OK' && step.detail)
			run.warnings.push(`${step.step}: ${step.detail}`);
	}

	if (run.crossCheck.missingInCpl.length > 0) {
		run.warnings.push(
			`${t('BOM 中有')} ${run.crossCheck.missingInCpl.length} ${t('个位号未出现在 CPL 中，请人工确认。')}`,
		);
	}

	// ---------- 写出报告（即使前面有失败也必须产出报告） ----------
	if (targetDir) {
		setExportProgress(96, t('正在写入导出报告…'));
		const reportResult = await guard('Export Report', async () => {
			await writeFileToDir(targetDir, reportFileName, buildReportBlob(run));
			return { result: { step: 'Export Report', status: 'OK' as const, fileName: reportFileName } };
		});

		if (reportResult.status === 'FAILED')
			run.warnings.push(`Export Report: ${reportResult.detail ?? t('(无详情)')}`);
	}

	// ---------- 完成窗口 ----------
	finishExportProgress(t('导出完成。'));
	showCompletion(run);
}

/* ------------------------------------------------------------------ *
 * 步骤守卫：把任何异常收敛为 StepResult，绝不让单点失败中断整体
 * ------------------------------------------------------------------ */

interface StepOutcomeLike {
	result: StepResult;
}

/** 执行一个导出步骤；任何异常都转成 FAILED 结果 */
async function guard(step: string, fn: () => Promise<StepOutcomeLike>): Promise<StepResult> {
	try {
		const outcome = await fn();
		logStepResult(outcome.result);
		return outcome.result;
	}
	catch (error) {
		const message = describeError(error);
		logError(`[${step}] Export failed: ${message}`);
		return { step, status: 'FAILED', detail: message };
	}
}

/** 同上，但保留步骤返回的附加数据（BOM 解析结果、CPL 过滤统计） */
async function guardWithPayload<T>(
	step: string,
	fn: () => Promise<{ result: StepResult; payload?: T }>,
): Promise<{ result: StepResult; payload?: T }> {
	try {
		const outcome = await fn();
		logStepResult(outcome.result);
		return outcome;
	}
	catch (error) {
		const message = describeError(error);
		logError(`[${step}] Export failed: ${message}`);
		return { result: { step, status: 'FAILED', detail: message } };
	}
}

function logStepResult(result: StepResult): void {
	if (result.status === 'OK')
		logInfo(`[${result.step}] OK → ${result.fileName ?? ''}`);
	else
		logError(`[${result.step}] ${result.status}: ${result.detail ?? ''}`);
}

/* ------------------------------------------------------------------ *
 * 杂项
 * ------------------------------------------------------------------ */

/**
 * 是否至少有一个导出步骤会执行。
 *
 * Gerber / BOM / CPL 为**必选项**（恒为 true），因此实际永远返回 `true`；
 * 保留该检查是为了在将来必选项可配置时不至于漏掉守卫。
 */
function hasAnyStep(settings: DeliverySettings): boolean {
	return settings.exportGerber
		|| settings.exportBom
		|| settings.exportCpl
		|| settings.exportSchematicPdf
		|| settings.exportStep
		|| settings.exportInteractiveBom
		|| settings.exportProjectV3
		|| settings.exportProjectV2;
}

/** 读取当前编辑器版本（失败返回空串，不阻断流程） */
function readEdaVersion(): string {
	try {
		return eda.sys_Environment.getEditorCurrentVersion() ?? '';
	}
	catch {
		return '';
	}
}

/** 读取运行环境（客户端 / 浏览器） */
function readRuntimeKind(): string {
	try {
		if (typeof eda.sys_Environment.isClient !== 'function')
			return '未知（无 isClient 接口）';
		return eda.sys_Environment.isClient() ? 'EasyEDA 客户端' : '浏览器';
	}
	catch {
		return '未知（isClient() 调用失败）';
	}
}

/**
 * 汇总运行时环境信息，写入导出报告的 ENVIRONMENT 段。
 *
 * 目的：同一个插件在 EasyEDA 3.2.149 与 4.x 上会走**不同的降级路径**。
 * 把「当时缺了哪些接口、各自降级成了什么、目录版本号是怎么判定的」写进报告，
 * 事后翻历史交付目录就能解释「为什么那次导出表现不一样」。
 */
function collectEnvironmentNotes(dirSource: string): string[] {
	const notes: string[] = [];

	try {
		notes.push(`运行时: ${readRuntimeKind()}`);
	}
	catch {
		/* 环境信息读取失败不影响导出 */
	}

	notes.push(`输出目录来源: ${dirSource || '(unknown)'}`);

	try {
		const missing = missingCapabilities();
		if (missing.length === 0) {
			notes.push('官方接口缺失: 无（本插件依赖的接口全部可用）');
		}
		else {
			notes.push(`官方接口缺失: 共 ${missing.length} 项`);
			for (const key of missing) {
				const meta = CAPABILITY_META[key];
				const suffix = meta?.since ? `（EDA ${meta.since} 引入）` : '';
				const impact = meta?.critical
					? '影响：无替代路径，对应功能不可用'
					: '影响：已自动降级，功能可用';
				notes.push(`  · ${key}${suffix} —— ${impact}`);
				if (!meta?.critical && meta?.fallback)
					notes.push(`      降级为：${meta.fallback}`);
			}
		}

		const advice = versionAdvice(readEdaVersion());
		if (advice.length > 0) {
			notes.push('');
			notes.push('版本建议:');
			for (const line of advice)
				notes.push(`  ${line}`);
		}
	}
	catch {
		/* 能力信息收集失败不影响导出 */
	}

	return notes;
}

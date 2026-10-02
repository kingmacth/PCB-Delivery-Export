/**
 * report.ts —— 生成 Export_Report.txt
 *
 * 目标（任务书第二十一节）：以后翻看历史交付目录时，能直接知道「当时导出成没成、过滤掉了什么」。
 * 因此报告必须**如实**记录：成功、失败、跳过、不支持，以及原因。
 */

import type { ExportRunResult, StepResult } from './types';

/** 把步骤结果格式化为 `Gerber: OK` / `STEP: FAILED` 这样的行 */
function formatStepLine(step: StepResult): string {
	const label = `${step.step}:`;
	switch (step.status) {
		case 'OK':
			return `${label} OK`;
		case 'FAILED':
			return `${label} FAILED`;
		case 'SKIPPED':
			return `${label} SKIPPED`;
		case 'NOT SUPPORTED':
			return `${label} NOT SUPPORTED`;
		default:
			return `${label} UNKNOWN`;
	}
}

const SEPARATOR = '--------------------------------';

/** 生成报告全文 */
export function buildReport(run: ExportRunResult): string {
	const lines: string[] = [];

	lines.push('PCB Delivery Export');
	lines.push('===================');
	lines.push('');
	lines.push('Board:');
	lines.push(run.boardName);
	lines.push('');
	lines.push('Export Date:');
	lines.push(run.exportDate);
	lines.push('');
	lines.push('EasyEDA Version:');
	lines.push(run.edaVersion || '(unknown)');
	lines.push('');
	lines.push('Plugin Version:');
	lines.push(run.pluginVersion);
	lines.push('');
	lines.push('Output Folder:');
	lines.push(run.outputDir || '(not created)');
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- FABRICATION REQUIREMENTS ----------
	const req = run.manufacturingRequirements;
	lines.push('');
	lines.push('制造要求 / FABRICATION REQUIREMENTS');
	lines.push('');
	lines.push(`板厚 / Board thickness: ${req.boardThicknessMm === 'Custom' ? '自定义 / Custom' : `${req.boardThicknessMm} mm`}`);
	lines.push(`阻焊颜色 / Solder mask: ${req.solderMaskColor}`);
	lines.push(`字符颜色 / Silkscreen: ${req.silkscreenColor}`);
	lines.push(`表面处理 / Surface finish: ${req.surfaceFinish}`);
	lines.push(`阻抗控制 / Impedance control: ${req.impedanceControl ? '需要 / REQUIRED' : '不需要 / NOT REQUIRED'}`);
	lines.push('自定义备注 / Custom notes:');
	lines.push(req.customNotes || '无 / None');
	lines.push('');
	lines.push('IMPORTANT: Verify every option on the manufacturer order page before production.');
	lines.push('重要：提交生产前，必须在制造商下单页面逐项确认。');
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- ENVIRONMENT ----------
	// 记录「当时跑在什么环境下、缺了哪些接口、走了哪条降级路径」。
	// 同一个插件在 EDA 3.2.149 与 4.x 上行为不同，留痕才能事后解释差异。
	lines.push('');
	lines.push('ENVIRONMENT');
	lines.push('');
	if (run.environmentNotes.length === 0) {
		lines.push('None');
	}
	else {
		for (const note of run.environmentNotes)
			lines.push(note);
	}
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- DRC ----------
	lines.push('');
	lines.push('DRC');
	lines.push('');
	if (!run.drc.executed) {
		lines.push('Status: NOT RUN');
		if (run.drc.error)
			lines.push(`Reason: ${run.drc.error}`);
	}
	else if (run.drc.passed) {
		lines.push('Status: PASSED');
	}
	else {
		lines.push('Status: NOT PASSED');
		lines.push('');
		lines.push('Item Count:');
		lines.push(String(run.drc.itemCount));
		if (run.drc.errorCount !== undefined) {
			lines.push('');
			lines.push('Errors:');
			lines.push(String(run.drc.errorCount));
		}
		if (run.drc.unroutedCount !== undefined) {
			lines.push('');
			lines.push('Unrouted:');
			lines.push(String(run.drc.unroutedCount));
		}
		if (run.drc.errorCount === undefined || run.drc.unroutedCount === undefined) {
			lines.push('');
			lines.push('(注意：官方 DRC 返回结构未公开，无法可靠拆分 Errors / Unrouted，');
			lines.push(' 此处仅给出条目总数。请在 PCB 编辑器内运行一次 DRC 查看明细。)');
		}
		if (run.drc.rawSummary) {
			lines.push('');
			lines.push('Raw Result (truncated):');
			lines.push(run.drc.rawSummary);
		}
	}
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- FILES ----------
	lines.push('');
	lines.push('FILES');
	lines.push('');
	for (const step of run.steps)
		lines.push(formatStepLine(step));
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- CPL FILTER ----------
	lines.push('');
	lines.push('CPL FILTER');
	lines.push('');
	if (!run.cplFilter.executed) {
		lines.push('Status: NOT EXECUTED');
		if (run.cplFilter.reason)
			lines.push(`Reason: ${run.cplFilter.reason}`);
	}
	else if (run.cplFilter.removedCount === 0) {
		lines.push('CPL/BOM Match: OK');
		lines.push('');
		lines.push('Original:');
		lines.push(String(run.cplFilter.originalCount));
		lines.push('');
		lines.push('Final:');
		lines.push(String(run.cplFilter.finalCount));
		lines.push('');
		lines.push('Removed:');
		lines.push('0');
	}
	else {
		lines.push('Original:');
		lines.push(String(run.cplFilter.originalCount));
		lines.push('');
		lines.push('Final:');
		lines.push(String(run.cplFilter.finalCount));
		lines.push('');
		lines.push('Removed:');
		lines.push(String(run.cplFilter.removedCount));
		lines.push('');
		lines.push('Removed Components:');
		lines.push('');
		for (const d of run.cplFilter.removedDesignators)
			lines.push(d);
	}
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- BOM WITHOUT CPL ----------
	lines.push('');
	lines.push('BOM COMPONENTS WITHOUT CPL');
	lines.push('');
	if (run.crossCheck.missingInCpl.length === 0) {
		lines.push('None');
	}
	else {
		for (const d of run.crossCheck.missingInCpl)
			lines.push(d);
		lines.push('');
		lines.push('WARNING: 这些位号存在于 BOM 但不在 CPL 中，可能是 THT 手焊件、机械件、');
		lines.push('无坐标元件或真实设计问题。插件不会自动补进 CPL，请人工确认。');
	}
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- WARNINGS ----------
	lines.push('');
	lines.push('WARNINGS');
	lines.push('');
	if (run.warnings.length === 0) {
		lines.push('None');
	}
	else {
		for (const w of run.warnings)
			lines.push(w);
	}
	lines.push('');
	lines.push(SEPARATOR);

	// ---------- ERRORS ----------
	lines.push('');
	lines.push('Errors:');
	lines.push('');

	const failedSteps = run.steps.filter(s => s.status === 'FAILED');
	if (run.fatalError)
		lines.push(`[FATAL] ${run.fatalError}`);

	if (failedSteps.length === 0 && !run.fatalError) {
		lines.push('None');
	}
	else {
		for (const step of failedSteps) {
			lines.push(`[${step.step}] Export failed:`);
			lines.push(step.detail ?? '(no detail)');
			lines.push('');
			lines.push('是否影响其它文件: 否 —— 各导出步骤相互独立，已成功的文件均完整保留。');
			lines.push('');
		}
	}

	lines.push('');
	lines.push('===================');
	lines.push('END OF REPORT');
	lines.push('');

	return lines.join('\n');
}

/** 报告文件名 */
export const REPORT_FILE_NAME = 'Export_Report.txt';

/** 生成报告的 Blob（带 UTF-8 BOM，便于 Windows 记事本正确识别中文） */
export function buildReportBlob(run: ExportRunResult): Blob {
	const text = buildReport(run);
	return new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' });
}

/**
 * 「占位报告」的内容。
 *
 * 用途见 paths.ts：在缺少目录存在性检查接口的旧版客户端上，
 * 插件用「写一个 force=false 的探测文件」来判断候选目录是否已被占用，
 * 探测文件就复用本报告的文件名（`Export_Report.txt`）——
 * 它是交付目录里必然存在的文件，探测成功后会被真正的报告覆盖，
 * 因此**不会留下任何多余文件**。
 *
 * 万一导出中途被中断，用户看到的也只是这份说明，而不是一个莫名其妙的空文件。
 */
export function buildPendingReportBlob(): Blob {
	const text = [
		'PCB Delivery Export',
		'===================',
		'',
		'本次导出尚未完成，或已在中途被取消。',
		'请重新执行一次「一键导出」以获得完整报告。',
		'',
		'（本文件是交付目录的占用探测标记，导出成功时会被完整报告覆盖。）',
		'',
	].join('\n');
	return new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' });
}

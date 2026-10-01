/**
 * summary.ts —— 导出完成窗口的文本汇总
 *
 * 对应任务书第二十二节。要求：
 *   - 显示输出目录
 *   - 逐项显示成功 / 失败 / 不支持
 *   - 显示 CPL 过滤统计（83 → 79、Removed 4）
 *   - 显示警告数量
 *
 * 不使用 ✓ / ✗ 之外的装饰字符，保证在弹窗中以等宽文本整齐对齐。
 */

import type { ExportRunResult, StepResult } from './types';

import { t } from './i18n';

/** 步骤状态 → 前缀符号 */
function statusMark(step: StepResult): string {
	switch (step.status) {
		case 'OK':
			return '✓';
		case 'FAILED':
			return '✗';
		case 'SKIPPED':
			return '–';
		case 'NOT SUPPORTED':
			return '×';
		default:
			return '?';
	}
}

/** 该步骤在汇总里展示的名字（去掉 Project 后面的格式后缀，格式另行显示） */
function displayStepName(step: StepResult): string {
	if (step.step === 'Project V3')
		return `${t('EasyEDA Project')} V3`;
	if (step.step === 'Project V2')
		return `${t('EasyEDA Project')} V2`;
	if (step.step === 'Schematic PDF')
		return t('Schematic PDF');
	if (step.step === 'iBOM')
		return t('交互式 BOM');
	return step.step;
}

/**
 * 生成完整的完成窗口文本。
 */
export function summarizeRun(run: ExportRunResult): string {
	const lines: string[] = [];

	if (run.fatalError) {
		lines.push(t('导出未能完成'));
		lines.push('');
		lines.push(run.fatalError);
		return lines.join('\n');
	}

	lines.push(t('Folder:'));
	lines.push(run.outputDir);

	// ---------- 关键降级提示：必须紧跟目录，第一时间被看到 ----------
	// 典型场景：所选目录写不进去 ⇒ 文件被改写到别处；或日期子目录建不出来 ⇒ 平铺输出。
	// 这类信息若只写进报告，用户会拿着「导出成功」的提示却找不到文件。
	if (run.criticalNotes.length > 0) {
		lines.push('');
		lines.push(`⚠ ${t('请注意')}`);
		for (const note of run.criticalNotes)
			lines.push(note);
	}

	lines.push('');

	// ---------- 文件清单 ----------
	for (const step of run.steps) {
		const mark = statusMark(step);
		if (step.status === 'OK') {
			lines.push(`${mark} ${displayStepName(step)}`);
		}
		else if (step.status === 'NOT SUPPORTED') {
			lines.push(`${mark} ${displayStepName(step)}  (${t('当前 API 不支持')})`);
		}
		else if (step.status === 'SKIPPED') {
			lines.push(`${mark} ${displayStepName(step)}  (${t('已跳过')})`);
		}
		else {
			lines.push(`${mark} ${displayStepName(step)}  ${t('失败')}`);
		}
	}

	// ---------- 失败详情 ----------
	const failedSteps = run.steps.filter(s => s.status === 'FAILED');
	if (failedSteps.length > 0) {
		lines.push('');
		lines.push(t('失败详情：'));
		for (const step of failedSteps) {
			lines.push(`[${step.step}] ${step.detail ?? t('(无详情)')}`);
			lines.push(t('  → 不影响其它文件，已生成的文件均完整保留。'));
		}
	}

	// ---------- CPL 过滤 ----------
	lines.push('');
	if (!run.cplFilter.executed) {
		lines.push(t('CPL Filter: NOT EXECUTED'));
		if (run.cplFilter.reason)
			lines.push(run.cplFilter.reason);
	}
	else if (run.cplFilter.removedCount === 0) {
		lines.push('CPL/BOM Match: OK');
		if (run.cplFilter.originalCount > 0) {
			lines.push(`${t('CPL 行数')}: ${run.cplFilter.originalCount} → ${run.cplFilter.finalCount}`);
		}
	}
	else {
		lines.push(`CPL: ${run.cplFilter.originalCount} → ${run.cplFilter.finalCount}`);
		lines.push('');
		lines.push(`${t('Removed')}: ${run.cplFilter.removedCount}`);
		lines.push('');
		lines.push(t('Removed Components:'));
		// 列表过长时折叠，避免弹窗超出屏幕
		const list = run.cplFilter.removedDesignators;
		const MAX_INLINE = 30;
		if (list.length <= MAX_INLINE) {
			lines.push(list.join('\n'));
		}
		else {
			lines.push(list.slice(0, MAX_INLINE).join('\n'));
			lines.push(`… ${t('以及另外')} ${list.length - MAX_INLINE} ${t('个，完整列表见 Export_Report.txt')}`);
		}
	}

	// ---------- BOM → CPL 反向检查 ----------
	if (run.crossCheck.missingInCpl.length > 0) {
		lines.push('');
		lines.push('WARNING');
		lines.push(t('BOM contains components not found in CPL:'));
		lines.push(run.crossCheck.missingInCpl.join('\n'));
		lines.push('');
		lines.push(t('Please verify manually.'));
	}

	// ---------- 警告数量 ----------
	lines.push('');
	const warnCount = run.warnings.length + (run.crossCheck.missingInCpl.length > 0 ? 1 : 0)
		+ run.steps.filter(s => s.status === 'FAILED').length;
	lines.push(`${t('Warnings')}: ${warnCount}`);
	lines.push(`${t('Errors')}: ${run.steps.filter(s => s.status === 'FAILED').length}`);

	if (warnCount > 0) {
		lines.push('');
		lines.push(t('详见导出目录下的 Export_Report.txt'));
	}

	return lines.join('\n');
}

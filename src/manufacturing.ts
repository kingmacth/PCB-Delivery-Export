import type { DeliverySettings, ManufacturingRequirements } from './types';

import JSZip from 'jszip';

export const REQUIREMENTS_FILE_ZH = '00_制造要求_请先阅读.txt';
export const REQUIREMENTS_FILE_EN = '00_FABRICATION_REQUIREMENTS_READ_FIRST.txt';

const ZH: Record<string, string> = {
	'Green': '绿色',
	'Red': '红色',
	'Yellow': '黄色',
	'Blue': '蓝色',
	'White': '白色',
	'Black': '黑色',
	'Purple': '紫色',
	'Lead-Free HASL': '无铅喷锡',
	'HASL (Leaded)': '有铅喷锡',
	'ENIG': '沉金',
	'OSP': 'OSP 抗氧化',
	'Custom / See notes': '自定义（见备注）',
	'Custom': '自定义（见备注）',
};

function bilingual(value: string): string {
	return ZH[value] ? `${value} / ${ZH[value]}` : value;
}

export function requirementsFromSettings(settings: DeliverySettings): ManufacturingRequirements {
	return {
		boardThicknessMm: settings.boardThicknessMm,
		solderMaskColor: settings.solderMaskColor,
		silkscreenColor: settings.silkscreenColor,
		surfaceFinish: settings.surfaceFinish,
		impedanceControl: settings.impedanceControl,
		customNotes: settings.manufacturingNotes,
	};
}

export function buildManufacturingRequirements(req: ManufacturingRequirements, boardName: string, exportDate: string): string {
	const thickness = req.boardThicknessMm === 'Custom' ? bilingual('Custom') : `${req.boardThicknessMm} mm`;
	return [
		'PCB 制造要求（请先阅读） / PCB FABRICATION REQUIREMENTS (READ FIRST)',
		'================================================================',
		'',
		`板名 / Board: ${boardName}`,
		`导出时间 / Export date: ${exportDate}`,
		'',
		`板厚 / Board thickness: ${thickness}`,
		`阻焊颜色 / Solder mask: ${bilingual(req.solderMaskColor)}`,
		`字符颜色 / Silkscreen: ${bilingual(req.silkscreenColor)}`,
		`表面处理 / Surface finish: ${bilingual(req.surfaceFinish)}`,
		`阻抗控制 / Impedance control: ${req.impedanceControl ? '需要 / REQUIRED' : '不需要 / NOT REQUIRED'}`,
		'',
		'自定义备注 / Custom notes:',
		req.customNotes || '无 / None',
		'',
		'重要提醒 / IMPORTANT:',
		'以上参数是交付与下单提醒，不会改变 Gerber 图形或自动填写制造商订单。',
		'These requirements are delivery/order reminders. They do not alter Gerber geometry or fill the manufacturer order automatically.',
		'提交生产前，必须在制造商下单页面逐项确认板厚、颜色、表面处理、阻抗及备注。',
		'Before fabrication, verify thickness, colors, finish, impedance and notes on the manufacturer order page.',
		'',
	].join('\n');
}

export function buildRequirementsBlob(text: string): Blob {
	return new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' });
}

export async function embedRequirementsInGerber(source: Blob, text: string): Promise<Blob> {
	const zip = await JSZip.loadAsync(await source.arrayBuffer());
	zip.file(REQUIREMENTS_FILE_ZH, `\uFEFF${text}`);
	zip.file(REQUIREMENTS_FILE_EN, `\uFEFF${text}`);
	const bytes = await zip.generateAsync({ type: 'uint8array' });
	return new Blob([bytes], { type: 'application/zip' });
}

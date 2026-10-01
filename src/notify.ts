/**
 * notify.ts —— 永不静默失败的通知层
 *
 * ## 为什么需要这一层
 * 第一版把所有用户提示都直接写成 `eda.sys_Dialog.showInformationMessage(...)`。
 * 如果该 API 在用户的 EasyEDA 版本 / 运行环境下不可用，调用会 `throw`，
 * 而此时**上报错误的路径本身也 `throw`**，异常最终变成一个
 * unhandled rejection —— 用户看到的现象就是「点了菜单，没有任何反应」。
 *
 * 这是本项目第一版交付后收到的真实反馈，因此这里把「让用户看到信息」
 * 做成一条**降级链**：任一层可用即返回，`notify()` 本身被设计为**永不抛出**，
 * 最后一关是 `console`，保证任何情况下都留有可追查的痕迹。
 *
 * ## 降级顺序
 *   1. `eda.sys_Dialog.showInformationMessage`  —— 官方 V3 推荐的信息弹窗
 *   2. `eda.sys_MessageBox.showInformationMessage` —— 旧版同名接口，作为兼容层
 *   3. `eda.sys_Message.showToastMessage`       —— 轻量 Toast
 *   4. 宿主 `window.alert`                      —— 浏览器 / 客户端兜底
 *   5. `console`                                —— 最后留痕
 */

import type { NotifyKind } from './types';

import {
	TOAST_ERROR,
	TOAST_SEC_BRIEF,
	TOAST_SEC_STICKY,
	TOAST_SUCCESS,
	TOAST_WARNING,
} from './edaCompat';

/** Toast 内容过长会遮住整个编辑器，这里主动截断 */
const MAX_TOAST_LENGTH = 800;

/** 1. 官方信息弹窗 */
function tryDialog(content: string, title: string): boolean {
	try {
		eda.sys_Dialog.showInformationMessage(content, title);
		return true;
	}
	catch {
		return false;
	}
}

/** 2. 旧版 MessageBox（方法名与 SYS_Dialog 一致，作为兼容降级） */
function tryMessageBox(content: string, title: string): boolean {
	try {
		eda.sys_MessageBox.showInformationMessage(content, title);
		return true;
	}
	catch {
		return false;
	}
}

/** 3. Toast */
function tryToast(content: string, kind: NotifyKind): boolean {
	try {
		const text = content.length > MAX_TOAST_LENGTH
			? `${content.slice(0, MAX_TOAST_LENGTH)}…`
			: content;

		let type: ESYS_ToastMessageType = TOAST_SUCCESS;
		let seconds = TOAST_SEC_BRIEF;
		if (kind === 'error') {
			type = TOAST_ERROR;
			seconds = TOAST_SEC_STICKY; // 错误信息要留够阅读时间
		}
		else if (kind === 'warn') {
			type = TOAST_WARNING;
			seconds = TOAST_SEC_STICKY;
		}

		// ⚠️ 第三个参数是「秒」，不是毫秒 —— 传 8000 会让 Toast 挂 2 小时 13 分。
		// 时长一律取自 edaCompat 的 TOAST_SEC_* 常量。
		eda.sys_Message.showToastMessage(text, type, seconds);

		return true;
	}
	catch {
		return false;
	}
}

/** 4. 宿主原生 alert */
function tryAlert(text: string): boolean {
	try {
		const alertFn = (globalThis as unknown as { alert?: (message: string) => void }).alert;
		if (typeof alertFn !== 'function')
			return false;
		alertFn(text);
		return true;
	}
	catch {
		return false;
	}
}

/** 5. 控制台留痕 */
function writeConsole(kind: NotifyKind, text: string): void {
	try {
		if (kind === 'error')
			console.error(text);
		else if (kind === 'warn')
			console.warn(text);
		else
			console.log(text);
	}
	catch {
		/* 连控制台都不可用：无处可写，只能放弃 */
	}
}

/**
 * 把一条信息送达用户。
 *
 * **本函数永不抛出** —— 这是本模块存在的全部意义。
 *
 * @param content 正文（支持 `\n` 换行）
 * @param title   标题
 * @param kind    信息级别，影响 Toast 配色与 console 通道
 */
export function notify(content: string, title?: string, kind: NotifyKind = 'info'): void {
	const heading = title ?? 'PCB Delivery Export';

	// 始终在控制台留一份，便于出现异常时远程排查
	writeConsole(kind, `[${heading}]\n${content}`);

	if (tryDialog(content, heading))
		return;
	if (tryMessageBox(content, heading))
		return;
	if (tryToast(content, kind))
		return;

	/* 所有官方通道都不可用时，退到宿主原生 alert；控制台里已有一份记录 */
	tryAlert(`${heading}\n\n${content}`);
}

/** 便捷封装：错误级通知 */
export function notifyError(content: string, title?: string): void {
	notify(content, title, 'error');
}

/** 便捷封装：警告级通知 */
export function notifyWarn(content: string, title?: string): void {
	notify(content, title, 'warn');
}

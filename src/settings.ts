/**
 * settings.ts —— 设置的读取与持久化
 *
 * 使用官方 `eda.sys_Storage`（扩展级用户配置存储）。
 * 采用**单键存整个 JSON 对象**的策略：读写次数最少、结构演进最方便。
 * 主扩展进程没有 localStorage，因此只使用官方 sys_Storage，并以写后读回为准。
 */

import type { DeliverySettings } from './types';

import { logWarn } from './edaCompat';

/**
 * 扩展配置存储键。
 * 导出是为了让诊断模块用**同一个键**做一次真实的读写探测，
 * 避免两处各写一个字面量、日后改一处漏一处。
 */
export const SETTINGS_STORAGE_KEY = 'delivery-settings';
const STORAGE_SETTLE_TIMEOUT_MS = 1_000;

/* ------------------------------------------------------------------ *
 * 主脚本 ↔ 配置窗口（sys_IFrame）的通信桥
 *
 * 官方文档推荐的跨上下文通信方式就是 sys_Storage：
 * 「主扩展进程和 sys_IFrame 是隔离的上下文，用 eda.sys_Storage 作为桥」。
 * 值一律存 **JSON 字符串**（部分客户端对对象值支持不稳），读取侧自行 parse。
 * ------------------------------------------------------------------ */

/** 主脚本 → 配置窗口：本次配置请求（设置快照 + 能力标记） */
export const UI_REQUEST_KEY = 'delivery-ui-request';

/** 配置窗口 → 主脚本：用户点「开始导出」后的配置结果 */
export const UI_RESULT_KEY = 'delivery-ui-result';

/** 配置窗口 → 主脚本：加载完成心跳（区分「窗口死了」与「用户主动关闭」） */
export const UI_ALIVE_KEY = 'delivery-ui-alive';

/** 配置窗口 → 主脚本：请求由主扩展上下文打开目录选择流程 */
export const UI_BROWSE_REQUEST_KEY = 'delivery-ui-browse-request';

/** 主脚本 → 配置窗口：目录选择结果 */
export const UI_BROWSE_RESULT_KEY = 'delivery-ui-browse-result';

/** 主脚本 → 配置窗口：导出阶段与百分比 */
export const UI_PROGRESS_KEY = 'delivery-ui-progress';

/**
 * 配置窗口桥「曾失败」的 EDA 版本标记。
 *
 * 用户实测反馈：「关闭重开还是这样」——窗口桥不通时，每次点菜单都会再弹一次
 * 失败的窗口。因此一旦确认桥不可用，就记下当时的客户端版本；
 * 同版本下后续直接走官方弹窗链，换版本（客户端更新过）才重新尝试一次。
 */
export const UI_BROKEN_KEY = 'delivery-ui-broken';

/** 读一个以 JSON 字符串存放的配置；不存在或解析失败返回 undefined */
export function readJsonConfig(key: string): unknown {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(key);
		if (raw === undefined || raw === null || raw === '')
			return undefined;
		if (typeof raw === 'string')
			return JSON.parse(raw);
		return raw; // 兼容直接存对象的旧数据
	}
	catch {
		return undefined;
	}
}

/**
 * 发起一次写入；Promise 形态会被 await，同步形态直接进入 then。
 * 返回**写入调用的返回值**（可能是 boolean / undefined / 已被 resolve 的值），
 * 永不 reject。只表示「调用发出去了」，**不代表真的存住了**。
 */
function issueSet(key: string, text: string): Promise<unknown> {
	let result: unknown;
	try {
		result = eda.sys_Storage.setExtensionUserConfig(key, text);
	}
	catch {
		return Promise.resolve(undefined);
	}
	if (result !== undefined && result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
		const settled = Promise.resolve(result).catch(() => undefined);
		return Promise.race([
			settled,
			new Promise<undefined>(resolve => globalThis.setTimeout(resolve, STORAGE_SETTLE_TIMEOUT_MS)),
		]);
	}
	return Promise.resolve(result);
}

/**
 * 写一个 JSON 字符串配置（同步、乐观）。
 *
 * 仅用于「写完不关心结果」的场景（清空键、记录失败标记）。
 * 需要确认真的存住了，请用 `writeJsonConfigVerified`。
 */
export function writeJsonConfig(key: string, value: unknown): boolean {
	try {
		eda.sys_Storage.setExtensionUserConfig(key, JSON.stringify(value));
		return true;
	}
	catch {
		return false;
	}
}

/**
 * 写一个 JSON 字符串配置并**读回校验**；返回是否真的存住了。
 *
 * ## 为什么不能看返回值
 * 官方签名 `setExtensionUserConfig(...): Promise<boolean>`，但各端实现并不统一：
 * 有的返回 `Promise<boolean>`、有的同步返回 `boolean`、有的返回 `undefined`。
 * v1.4.0 的配置窗口曾用 `=== true` 判定 —— Promise 永远不等于 `true`，
 * 于是**每个客户端**都误报「无法写入扩展存储」并禁用按钮（真机事故）。
 * 「写后读回一致」是唯一与返回值约定无关的判据。
 */
export async function writeJsonConfigVerified(key: string, value: unknown): Promise<boolean> {
	const text = JSON.stringify(value);
	await issueSet(key, text);
	try {
		const back = eda.sys_Storage.getExtensionUserConfig(key);
		return String(back) === text;
	}
	catch {
		return false;
	}
}

/** 清空一个配置键（尽力而为） */
export function clearJsonConfig(key: string): void {
	try {
		eda.sys_Storage.setExtensionUserConfig(key, '');
	}
	catch {
		/* ignore */
	}
}

export const DEFAULT_SETTINGS: DeliverySettings = {
	// 制造文件 —— 必选项：始终导出，不可取消
	exportGerber: true,
	exportBom: true,
	exportCpl: true,
	cplFilterEnabled: true,
	// 设计文档
	exportSchematicPdf: false,
	exportStep: false,
	exportInteractiveBom: false,
	// 3D HTML：官方 API 不支持，固定关闭（不可勾选）
	export3DHtml: false,
	// 工程源文件：V3 为默认；V2 需要用户显式勾选
	exportProjectV3: false,
	exportProjectV2: false,
	// 检查
	runDrc: false,
	// 输出
	outputDir: '',
	rememberOutputDir: true,
};

/** 布尔型设置项清单（用于 normalizeSettings 的类型守卫） */
const BOOLEAN_KEYS = [
	'cplFilterEnabled',
	'exportSchematicPdf',
	'exportStep',
	'exportInteractiveBom',
	'exportProjectV3',
	'exportProjectV2',
	'runDrc',
	'rememberOutputDir',
] as const;

function isBoolean(v: unknown): v is boolean {
	return typeof v === 'boolean';
}

function isString(v: unknown): v is string {
	return typeof v === 'string';
}

/**
 * 把任意来源的对象「清洗」为合法设置。
 * 关键点：任何字段缺失或类型不对，都回退到默认值，避免旧版本设置污染新版本。
 */
export function normalizeSettings(raw: unknown): DeliverySettings {
	const out: DeliverySettings = { ...DEFAULT_SETTINGS };
	if (!raw || typeof raw !== 'object')
		return out;

	const src = raw as Record<string, unknown>;

	for (const key of BOOLEAN_KEYS) {
		if (isBoolean(src[key]))
			out[key] = src[key] as boolean;
	}

	if (isString(src.outputDir))
		out.outputDir = src.outputDir.trim();

	// ---------- 旧版设置迁移 ----------
	// v1.0.0 使用单个 `projectFormat: 'V3' | 'V2'` 描述工程文件格式，
	// v1.1.0 改为 V3 / V2 两个独立勾选项。这里做一次性迁移，避免用户设置丢失。
	if (src.exportProjectV3 === undefined && src.exportProjectV2 === undefined) {
		const legacyEnabled = isBoolean(src.exportProject) ? src.exportProject : true;
		const legacyFormat = isString(src.projectFormat)
			? (src.projectFormat.toUpperCase() === 'V2' ? 'V2' : 'V3')
			: 'V3';
		if (!legacyEnabled) {
			out.exportProjectV3 = false;
			out.exportProjectV2 = false;
		}
		else {
			out.exportProjectV3 = legacyFormat === 'V3';
			out.exportProjectV2 = legacyFormat === 'V2';
		}
	}

	// ---------- 不可动摇的约束 ----------
	// 必选项：Gerber / BOM / CPL 恒为 true（用户明确要求「默认必选」）
	out.exportGerber = true;
	out.exportBom = true;
	out.exportCpl = true;
	// 3D HTML 恒为 false：官方 API 尚未提供该导出能力
	out.export3DHtml = false;

	return out;
}

/** 读取设置（永不抛出）。 */
export function loadSettings(): DeliverySettings {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(SETTINGS_STORAGE_KEY);
		if (raw !== undefined && raw !== null && raw !== '') {
			// v1.4.0 起统一存 JSON 字符串；兼容旧版本直接存对象的形态
			const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
			return normalizeSettings(parsed);
		}
	}
	catch (error) {
		logWarn(`loadSettings via sys_Storage failed: ${String(error)}`);
	}

	return { ...DEFAULT_SETTINGS };
}

/**
 * 保存设置（永不抛出；返回是否成功）。
 *
 * ## 为什么存 JSON 字符串而不是对象
 * 类型定义声明 `value: any`，但用户真机（EasyEDA 3.2.149）反馈「选项没有保存」——
 * 主扩展进程里**没有 localStorage**（官方文档明确其只在 sys_IFrame 内可用），
 * 一旦 `setExtensionUserConfig(对象)` 静默失败，连兜底都存不住，设置就彻底丢了。
 * 字符串是最保守、各端行为最一致的形态；且写入后立即**读回校验**，
 * 失败会被如实记录，而不是默默丢数据。
 */
export async function saveSettings(settings: DeliverySettings): Promise<boolean> {
	const payload = normalizeSettings(settings);
	const text = JSON.stringify(payload);
	await issueSet(SETTINGS_STORAGE_KEY, text);
	let ok = false;
	try {
		const back = eda.sys_Storage.getExtensionUserConfig(SETTINGS_STORAGE_KEY);
		const parsed = typeof back === 'string' ? JSON.parse(back) : back;
		ok = JSON.stringify(normalizeSettings(parsed)) === JSON.stringify(payload);
	}
	catch (error) {
		logWarn(`saveSettings read-back failed: ${String(error)}`);
	}

	if (!ok)
		logWarn('设置写入后读回不一致，本次选择将不会被记住。');

	return ok;
}

/**
 * edaCompat.ts —— 对官方 API 的「运行时安全」常量与轻量封装
 *
 * ⚠️ 重要背景（详见 API_NOTES.md 第十节）
 * `@jlceda/pro-api-types` 是**纯类型包**（文件结尾为 `export {}`，全部内容位于 `declare global` 内），
 * 它在运行时**不导出任何值**。因此下面这种写法在类型检查阶段合法、但在真机运行时会崩溃：
 *
 *     eda.pcb_ManufactureData.getPickAndPlaceFile(name, 'xlsx', ESYS_Unit.MILLIMETER);
 *     // Runtime: ReferenceError: ESYS_Unit is not defined
 *
 * 正确做法是使用**字面量 + 类型断言**：既有完整类型检查，运行时不依赖枚举对象。
 */

/** ESYS_Unit.MILLIMETER === 'mm' */
export const UNIT_MM = 'mm' as ESYS_Unit.MILLIMETER;

/** ESCH_ExportDocumentFileType.PDF === 'PDF' */
export const DOC_TYPE_PDF = 'PDF' as ESCH_ExportDocumentFileType;

/** EDMT_EditorDocumentType.PCB === 3 */
export const DOC_TYPE_PCB = 3 as EDMT_EditorDocumentType.PCB;

/** ESYS_LogType */
export const LOG_INFO = 'info' as ESYS_LogType.INFO;
export const LOG_WARN = 'warn' as ESYS_LogType.WARNING;
export const LOG_ERROR = 'error' as ESYS_LogType.ERROR;

/** ESYS_ToastMessageType */
export const TOAST_SUCCESS = 'success' as ESYS_ToastMessageType.SUCCESS;
export const TOAST_ERROR = 'error' as ESYS_ToastMessageType.ERROR;
export const TOAST_WARNING = 'warn' as ESYS_ToastMessageType.WARNING;

/**
 * Toast 自动关闭倒计时 —— **单位是「秒」，不是毫秒**。
 *
 * ## 真实事故：「这几个信息条一直不消失」
 *
 * 官方签名（`@jlceda/pro-api-types`）：
 *
 *     showToastMessage(message, messageType?, timer?, ...)
 *     @param timer - 自动关闭倒计时秒数，`0` 为不自动关闭
 *
 * 第一版按「毫秒」的直觉传了 `8000`、`6000`、`3000`，
 * 实际效果是让 Toast 挂 **8000 秒（2 小时 13 分）** 才消失 ——
 * 用户看到的就是「进度条卡在那里，再也下不去」。
 *
 * 因此：
 *   1. 所有时长一律取自下面这组带 `_SEC` 后缀的常量，禁止直接写字面量；
 *   2. 命名里写明单位，避免再次误读；
 *   3. `tests/` 中有断言确保传给官方的 timer 落在合理区间。
 */

/** 进度类提示：一闪而过即可，太长会堆积 */
export const TOAST_SEC_PROGRESS = 3;
/** 常规提示：够读完一句话 */
export const TOAST_SEC_BRIEF = 6;
/** 需要用户读完的重要信息（例如错误），但仍会自行消失 */
export const TOAST_SEC_STICKY = 15;

/** Toast 时长的合法上限；用于自测断言，防止再次误传毫秒 */
export const TOAST_SEC_MAX = 60;

/**
 * 统一的日志出口。
 * 开发阶段输出到 EDA 日志面板，便于排查；不向主线程 console 大量刷屏。
 */
export function logInfo(message: string): void {
	try {
		eda.sys_Log.add(`[PCB Delivery] ${message}`, LOG_INFO);
	}
	catch {
		/* 日志失败不影响主流程 */
	}
}

export function logWarn(message: string): void {
	try {
		eda.sys_Log.add(`[PCB Delivery] ${message}`, LOG_WARN);
	}
	catch {
		/* ignore */
	}
}

export function logError(message: string): void {
	try {
		eda.sys_Log.add(`[PCB Delivery] ${message}`, LOG_ERROR);
	}
	catch {
		/* ignore */
	}
}

/** 把任意异常规格化为「可读、可写入报告」的字符串。 */
export function describeError(error: unknown): string {
	if (error === null)
		return 'null';
	if (error === undefined)
		return 'undefined';
	if (typeof error === 'string')
		return error;
	if (error instanceof Error) {
		const name = error.name || 'Error';
		const msg = error.message || '(no message)';
		const stack = error.stack ? `\n${error.stack.split('\n').slice(0, 4).join('\n')}` : '';
		return `${name}: ${msg}${stack}`;
	}
	try {
		return JSON.stringify(error);
	}
	catch {
		return String(error);
	}
}

/** 更贴合真机的异常（可携带「哪个步骤失败 / 是否影响其它文件」信息）。 */
export class ExportStepError extends Error {
	readonly step: string;
	readonly cause: unknown;

	constructor(step: string, message: string, cause?: unknown) {
		super(message);
		this.name = 'ExportStepError';
		this.step = step;
		this.cause = cause;
	}
}

/* ------------------------------------------------------------------ *
 * 超时与软调用
 *
 * ## 为什么必须给官方接口加超时（真实事故）
 *
 * 第一版收到反馈「导入后点了，没有任何反应」。排查后确认了一个**设计层缺陷**：
 * 旧实现是「先 `await` 官方查询接口，再弹配置窗口」——
 *
 *     await isPcbDocumentOpen();      // ← 若此调用在旧版客户端上迟迟不返回
 *     await checkRuntimeEnvironment();
 *     startConfigFlow(...);           // ← 就永远执行不到，用户看到纯空白
 *
 * 这类「接口存在但永不返回」的挂起，`try/catch` 是抓不住的：
 * 它不是错误，只是永远没有结果。唯一的解法是**加硬超时**，
 * 把「永久挂起」降级为「有界等待 + 回退默认值」。
 *
 * 需要强调的是：只有**元数据类**查询才加短超时（毫秒～秒级就应返回）；
 * 真正耗时的导出动作（生成 Gerber、写大文件）给的是很宽松的上限，
 * 避免在大板子上误判失败。
 * ------------------------------------------------------------------ */

/** 官方接口超时。与网络超时无关，纯粹是「对方没动静」的兜底。 */
export class ApiTimeoutError extends Error {
	readonly label: string;
	readonly timeoutMs: number;

	constructor(label: string, timeoutMs: number) {
		super(`接口 ${label} 在 ${timeoutMs} ms 内没有返回结果`);
		this.name = 'ApiTimeoutError';
		this.label = label;
		this.timeoutMs = timeoutMs;
	}
}

/** 元数据类查询的默认超时：这类调用正常应在毫秒级返回 */
export const METADATA_TIMEOUT_MS = 5_000;

/**
 * 文件系统类查询的超时。
 *
 * `sys_FileSystem.*`（除两个原生选择框外）全部要求「外部交互」权限，
 * 实测 **EasyEDA 3.2.149 上这一族接口会直接挂起、既不返回也不抛错**
 * （用户实测：`getDocumentsPath()` 超过 5000 ms 未返回，而权限是开着的）。
 * 因此文件系统调用统一用比普通元数据更短的上限，尽快把「挂起」暴露出来。
 */
export const FS_TIMEOUT_MS = 6_000;

/**
 * 目录探测写入的超时（小文件，写一个占位报告）。
 *
 * 旧的 20 s 是错的：探测失败会被当成「目录已被占用」继续换槽位重试，
 * 20 s × 20 次 = 最长 400 s 的假死，用户看到的就是「卡住了不动」。
 * 现在缩短到 10 s，并且**超时不重试**（见 paths.ts 的说明）。
 */
export const DIR_PROBE_TIMEOUT_MS = 10_000;

/** 交付文件写入的超时：动辄数 MB，给足余量，只用于防永久挂起 */
export const DELIVERABLE_WRITE_TIMEOUT_MS = 300_000;

/** 制造文件生成、DRC 等耗时官方调用的硬超时。 */
export const EXPORT_API_TIMEOUT_MS = 300_000;

/** 判断一个异常是否为「接口超时」。超时与失败的处理策略不同，必须区分。 */
export function isTimeoutError(error: unknown): boolean {
	return error instanceof ApiTimeoutError;
}

/**
 * 给任意 Promise 套一个硬超时。
 *
 * @throws {ApiTimeoutError} 超时时抛出；原 Promise 的异常按原样透传
 */
export async function withTimeout<T>(
	promise: Promise<T> | T,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve(promise),
			new Promise<never>((_resolve, reject) => {
				timer = globalThis.setTimeout(() => {
					reject(new ApiTimeoutError(label, timeoutMs));
				}, timeoutMs);
			}),
		]);
	}
	finally {
		if (timer !== undefined)
			globalThis.clearTimeout(timer);
	}
}

/**
 * 软调用：带超时地执行一个官方 API 调用，任何失败（缺失 / 抛错 / 超时）
 * 都回退到 `fallback` 并写警告日志，**绝不向外抛异常**。
 *
 * 用在「拿不到结果也能继续」的场景，例如前置检查、可选信息查询。
 */
export async function softCall<T>(
	label: string,
	timeoutMs: number,
	fn: () => Promise<T> | T,
	fallback: T,
): Promise<T> {
	try {
		return await withTimeout(fn(), timeoutMs, label);
	}
	catch (error) {
		logWarn(`[${label}] ${describeError(error)} —— 已按降级值继续`);
		return fallback;
	}
}

/** 一次尝试的结果：`ok` 表示接口本身可用，`value` 表示接口给出的值 */
export interface AttemptResult<T> {
	/**
	 * `false` = 接口不可用（不存在 / 抛错 / 超时），应当换用下一档方案；
	 * `true`  = 接口可用；此时 `value` 为 `undefined` 表示**用户主动取消**。
	 */
	ok: boolean;
	value?: T;
}

/**
 * 「尝试并区分取消」的调用封装。
 *
 * 选择类弹窗（目录选择框 / 输入框）有个关键语义差别：
 *   - 接口不可用 → 应该换用别的降级方案；
 *   - 用户取消   → 应该尊重用户，停止追问。
 * 两者都表现为「没拿到值」，必须区分开，否则会出现
 * 「用户取消了一个弹窗，插件又弹一个」的糟糕体验。
 */
export async function attempt<T>(
	label: string,
	timeoutMs: number,
	fn: () => Promise<T> | T,
): Promise<AttemptResult<T>> {
	try {
		const value = await withTimeout(fn(), timeoutMs, label);
		return { ok: true, value };
	}
	catch (error) {
		logWarn(`[${label}] ${describeError(error)}`);
		return { ok: false };
	}
}

/** 把可能抛异常 / 返回 undefined 的官方 API 调用，收拢为统一的结果对象。 */
export interface ApiCallResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
}

export async function safeCall<T>(step: string, fn: () => Promise<T>): Promise<ApiCallResult<T>> {
	try {
		const value = await withTimeout(fn(), EXPORT_API_TIMEOUT_MS, step);
		return { ok: true, value };
	}
	catch (error) {
		const message = describeError(error);
		logError(`[${step}] API call failed: ${message}`);
		return { ok: false, error: message };
	}
}

/** 判断文件是否是「真的有内容」，官方 API 失败时普遍返回 `undefined` 或空文件。 */
export async function isUsableFile(file: File | undefined | null): Promise<boolean> {
	if (!file)
		return false;
	try {
		return file.size > 0;
	}
	catch {
		return true;
	}
}

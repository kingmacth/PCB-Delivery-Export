/**
 * ui.ts —— 配置界面与结果反馈
 *
 * ## 交互流程
 *   `exportDeliveryPackage()`
 *     └─ PCB 文档检查（带硬超时，失败不阻断）
 *        └─ **主配置窗口**（两条路径，自动选择）
 *           ├─ A. `sys_IFrame.openIFrame('/iframe/config.html')`
 *           │     完全自定义窗口：复选框**平铺**、输出目录行 + **浏览按钮**、
 *           │     与主脚本经 `sys_Storage` 桥通信（官方推荐的跨上下文方式）。
 *           │     窗口加载后写「心跳」；点「开始导出」写结果并自关；
 *           │     用户点 ✕ = 取消。若窗口死了（无心跳）→ 自动回退 B。
 *           └─ B. 官方弹窗链（`showSelectDialog` 多选）——回退路径
 *              └─ 需要设置输出目录时 → `resolveOutputDirectory()`（五级降级链）
 *                 └─ 执行导出 → 完成窗口
 *
 * ## 为什么 A 是首选
 * 用户实测反馈（EasyEDA 3.2.149）：
 *   1. `showSelectDialog(multiple:true)` 在客户端渲染为**可折叠下拉**，
 *      「选项被折叠/要滚动」，且用户明确要求「选项平铺到界面上」；
 *   2. 「路径添加一个浏览按钮」。
 * 官方 `sys_IFrame.openIFrame` 文档明确：IFrame 内可直接访问全局 `eda`，
 * 主脚本与 IFrame 之间用 `sys_Storage` 作为数据桥 —— 通信方式是官方支持的，
 * 不是 DOM hack；窗口仍打不开/读不到数据时自动回退弹窗链，功能不受损。
 *
 * ## 主窗口里的必选项
 * Gerber / BOM / 坐标文件 CPL 不可取消，写在窗口说明区恒定导出，
 * 不做成复选框（做成可勾选只会让用户以为能关掉）。
 *
 * ## 通知一律走 notify.ts
 * 所有面向用户的提示都经由 `notify()` 发出，它在官方弹窗不可用时会自动降级，
 * **永不静默失败**（详见 notify.ts 顶部说明）。
 */

import type { DeliverySettings, DrcResult, ExportRunResult } from './types';

import { can, getCapabilities } from './capabilities';
import {
	attempt,
	describeError,
	FS_TIMEOUT_MS,
	logInfo,
	logWarn,
	softCall,
	TOAST_SEC_PROGRESS,
	withTimeout,
} from './edaCompat';
import { IS_3D_HTML_SUPPORTED, IS_INTERACTIVE_BOM_SUPPORTED } from './exporters';
import { t } from './i18n';
import { notify, notifyError, notifyWarn } from './notify';
import { dirnameOf, joinPath } from './paths';
import {
	clearJsonConfig,
	readJsonConfig,
	UI_ALIVE_KEY,
	UI_BROKEN_KEY,
	UI_BROWSE_REQUEST_KEY,
	UI_BROWSE_RESULT_KEY,
	UI_PROGRESS_KEY,
	UI_REQUEST_KEY,
	UI_RESULT_KEY,
	writeJsonConfig,
	writeJsonConfigVerified,
} from './settings';
import { summarizeRun } from './summary';

/** 复选项的稳定内部键（不随语言变化，用于持久化与判断） */
export const OPTION_KEYS = {
	cplFilter: 'cplFilter',
	schematicPdf: 'schematicPdf',
	step: 'step',
	interactiveBom: 'interactiveBom',
	projectV3: 'projectV3',
	projectV2: 'projectV2',
	runDrc: 'runDrc',
	changeOutputDir: 'changeOutputDir',
} as const;

type OptionKey = (typeof OPTION_KEYS)[keyof typeof OPTION_KEYS];

/** 等待确认弹窗回调的兜底上限：超过则按默认行为继续，避免流程永久挂起 */
const CONFIRM_TIMEOUT_MS = 120_000;

/**
 * 等待用户交互类弹窗（目录选择框 / 输入框）的上限。
 * 取值很长是刻意的：用户可能正在思考或粘贴路径，此时**不该**打断他。
 * 它的唯一作用是在弹窗回调静默失效时兜底，而不是限制用户操作时间。
 */
const PICKER_TIMEOUT_MS = 300_000;

/** 旧版文件夹 API 偶发不弹窗也不返回；15 秒后必须继续走后备路径。 */
const FOLDER_API_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------ *
 * 文档前置检查
 * ------------------------------------------------------------------ */

/** EDMT_EditorDocumentType.PCB === 3 */
const DOC_TYPE_PCB = 3 as EDMT_EditorDocumentType.PCB;

/** PCB 文档是否已打开 */
export async function isPcbDocumentOpen(): Promise<boolean> {
	try {
		const current = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		return current?.documentType === DOC_TYPE_PCB;
	}
	catch (error) {
		// 查询失败不等于“没打开”；记录后放行，让制造接口给出真实结果。
		logWarn(`${t('无法读取当前文档信息：')} ${describeError(error)}`);
		return true;
	}
}

/** 「请先打开 PCB 文档。」提示 */
export function showNoPcbMessage(): void {
	notify(t('请先打开 PCB 文档。'), t('PCB Delivery Export'));
}

/** 通用信息弹窗 */
export function showInfo(content: string, title?: string): void {
	notify(content, title ?? t('PCB Delivery Export'));
}

/* ------------------------------------------------------------------ *
 * 弹窗 Promise 包装（仅用于信息类、无取消语义的弹窗）
 * ------------------------------------------------------------------ */

/**
 * 确认弹窗 → Promise<boolean>。
 *
 * `showConfirmationMessage` 的回调在**两个按钮**上都会触发，因此等待是安全的。
 * 两道保险：
 *   1. 若弹窗接口本身 `throw`（API 不可用），立即按 `fallback` 继续并告知用户；
 *   2. 若回调迟迟不触发（接口静默失效），超时后按 `fallback` 继续，绝不让插件挂死。
 */
function confirmAsync(
	content: string,
	title: string,
	mainButton: string,
	cancelButton: string,
	fallback: boolean,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled)
				return;
			settled = true;
			resolve(value);
		};

		const timer = globalThis.setTimeout(() => {
			notifyWarn(
				`${t('确认窗口在 120 秒内没有返回结果，已按默认行为继续。')}`,
				title,
			);
			finish(fallback);
		}, CONFIRM_TIMEOUT_MS);

		try {
			eda.sys_Dialog.showConfirmationMessage(
				content,
				title,
				mainButton,
				cancelButton,
				(clicked: boolean) => {
					globalThis.clearTimeout(timer);
					finish(clicked === true);
				},
			);
		}
		catch (error) {
			globalThis.clearTimeout(timer);
			notifyWarn(
				`${t('无法显示确认窗口，已按默认行为继续。')}\n${describeError(error)}`,
				title,
			);
			finish(fallback);
		}
	});
}

/**
 * 文本输入弹窗 → Promise<string | undefined>。
 *
 * 用法与 `confirmAsync` 一致：`undefined` 表示「用户取消」或「弹窗不可用」，
 * 由调用方决定是保留原值还是继续降级。
 */
function inputAsync(
	beforeContent: string,
	afterContent: string,
	title: string,
	initialValue: string,
): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		let settled = false;
		const finish = (value?: string): void => {
			if (settled)
				return;
			settled = true;
			resolve(value);
		};

		const timer = globalThis.setTimeout(() => {
			notifyWarn(t('输入窗口长时间没有返回结果，已按取消处理。'), title);
			finish(undefined);
		}, PICKER_TIMEOUT_MS);

		try {
			eda.sys_Dialog.showInputDialog(
				beforeContent,
				afterContent,
				title,
				'text',
				initialValue,
				{ placeholder: 'D:\\PCB_Output' },
				(value: unknown) => {
					globalThis.clearTimeout(timer);
					const text = typeof value === 'string' ? value.trim() : '';
					finish(text.length > 0 ? text : undefined);
				},
			);
		}
		catch (error) {
			globalThis.clearTimeout(timer);
			notifyWarn(
				`${t('无法显示输入窗口，将继续尝试其它方式。')}\n${describeError(error)}`,
				title,
			);
			finish(undefined);
		}
	});
}

/* ------------------------------------------------------------------ *
 * 单选弹窗 → Promise
 * ------------------------------------------------------------------ */

/**
 * 单选弹窗 → Promise<string | undefined>。
 *
 * 官方 `showSelectDialog(multiple: false)` 是回调式的，这里同样加超时兜底：
 * 接口静默失效时绝不永久等待。`undefined` 表示「取消」或「不可用」。
 */
function selectAsync(
	options: Array<{ value: string; displayContent: string }>,
	beforeContent: string,
	afterContent: string,
	title: string,
	defaultValue?: string,
): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		let settled = false;
		const finish = (value?: string): void => {
			if (settled)
				return;
			settled = true;
			resolve(value);
		};

		const timer = globalThis.setTimeout(() => {
			notifyWarn(t('选择窗口长时间没有返回结果，已按取消处理。'), title);
			finish(undefined);
		}, PICKER_TIMEOUT_MS);

		const normalize = (raw: unknown): string | undefined => {
			// 多选被旧版客户端当单选处理时会回传数组，取第一项即可
			const first = Array.isArray(raw) ? raw[0] : raw;
			return typeof first === 'string' && first.length > 0 ? first : undefined;
		};

		try {
			eda.sys_Dialog.showSelectDialog(
				options,
				beforeContent,
				afterContent,
				title,
				defaultValue,
				false,
				(value: unknown) => {
					globalThis.clearTimeout(timer);
					finish(normalize(value));
				},
			);
		}
		catch (error) {
			globalThis.clearTimeout(timer);
			notifyWarn(
				`${t('无法显示选择窗口，将继续尝试其它方式。')}\n${describeError(error)}`,
				title,
			);
			finish(undefined);
		}
	});
}

/* ------------------------------------------------------------------ *
 * 文件夹逐级浏览（用列目录接口实现）
 *
 * ## 为什么需要自己做一个浏览器
 * 用户的 EasyEDA 3.2.149 上，两个原生选择框接口**都不存在**：
 *   - `openReadFolderPathDialog`  MISS
 *   - `openReadFilePathDialog`    MISS
 * 只剩「手填路径」一条路，用户明确不接受：「存储路径应该是浏览的，不是添的」。
 *
 * 但 `listFilesOfFileSystem` 是**可用**的，且返回结构里有
 * `isDirectory` 与 `fullPath`（见 API_NOTES.md 第五节）。
 * 于是可以用官方列目录接口拼出一个真正的逐级浏览：
 * 盘符 → 逐级进子目录 → 选中当前目录。全程只用官方接口，无 DOM、无伪造。
 *
 * ## 接口挂起的处理
 * 该族接口在本机可能永久挂起，所以每次列目录都套 `FS_TIMEOUT_MS`；
 * 一旦超时就明确告知并交回给「手填路径」兜底，绝不反复重试。
 * ------------------------------------------------------------------ */

/** 浏览时单页最多列出的子目录数，避免弹窗过长 */
const BROWSE_MAX_ENTRIES = 60;

/** 浏览时的最大层级深度，防止用户一路点下去出不来 */
const BROWSE_MAX_DEPTH = 40;

/** 浏览用选项的内部键前缀（与真实路径区分开） */
const BROWSE_PREFIX = {
	use: '__use__',
	up: '__up__',
	manual: '__manual__',
	root: '__root__',
	dir: '__dir__',
} as const;

interface DirEntry {
	name: string;
	fullPath: string;
}

/** 列出目录下的子目录；能力缺失 / 超时 / 异常时返回 undefined */
async function listSubDirectories(dir: string): Promise<DirEntry[] | undefined> {
	if (!can('sys_FileSystem.listFilesOfFileSystem'))
		return undefined;

	try {
		const entries = await withTimeout(
			eda.sys_FileSystem.listFilesOfFileSystem(dir, false),
			FS_TIMEOUT_MS,
			`listFilesOfFileSystem(${dir})`,
		);
		if (!Array.isArray(entries))
			return undefined;

		const dirs: DirEntry[] = [];
		for (const raw of entries) {
			const item = raw as {
				fileName?: unknown;
				fullPath?: unknown;
				isDirectory?: unknown;
			} | undefined;
			if (item?.isDirectory !== true)
				continue;
			const name = typeof item.fileName === 'string' ? item.fileName : '';
			if (!name)
				continue;
			const full = typeof item.fullPath === 'string' && item.fullPath
				? item.fullPath
				: joinPath(dir, name);
			dirs.push({ name, fullPath: full });
		}

		dirs.sort((a, b) => a.name.localeCompare(b.name));
		return dirs;
	}
	catch (error) {
		logWarn(`列目录失败（${dir}）：${describeError(error)}`);
		return undefined;
	}
}

/** 取上一级目录；已在根目录时返回 undefined */
function parentOf(dir: string): string | undefined {
	const trimmed = dir.replace(/[\\/]+$/, '');
	const sep = trimmed.includes('\\') ? '\\' : '/';
	const idx = trimmed.lastIndexOf(sep);
	if (idx <= 0)
		return undefined;
	const parent = trimmed.slice(0, idx);
	// `C:` → `C:\`，保证始终是绝对路径
	return /^[a-z]:$/i.test(parent) ? `${parent}${sep}` : parent;
}

/** 浏览的起始根目录候选：优先用能问到的真实路径，再补常见盘符 */
async function discoverRoots(): Promise<string[]> {
	const roots: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value !== 'string')
			return;
		const trimmed = value.trim();
		if (!trimmed || roots.includes(trimmed))
			return;
		roots.push(trimmed);
	};

	// 工程所在目录：一定存在、一定有写权限，是最实用的起点
	if (can('sys_FileSystem.getProjectsPaths')) {
		const paths = await softCall(
			'sys_FileSystem.getProjectsPaths',
			FS_TIMEOUT_MS,
			() => eda.sys_FileSystem.getProjectsPaths(),
			undefined as Array<string> | undefined,
		);
		if (Array.isArray(paths)) {
			for (const p of paths)
				push(dirnameOf(p));
		}
	}

	// EDA 安装目录所在盘
	if (can('sys_FileSystem.getEdaPath')) {
		const edaPath = await softCall(
			'sys_FileSystem.getEdaPath',
			FS_TIMEOUT_MS,
			() => eda.sys_FileSystem.getEdaPath(),
			'',
		);
		push(dirnameOf(edaPath));
	}

	// 常见盘符兜底
	for (const drive of ['C', 'D', 'E', 'F'])
		push(`${drive}:\\`);

	return roots;
}

/**
 * 逐级浏览并挑选一个输出目录。
 *
 * @returns 用户确认的目录；用户取消或列目录不可用时返回 `undefined`
 *          （调用方应继续降级到「手填路径」）
 */
async function browseForDirectory(startDir?: string): Promise<ResolvedDirectory | undefined> {
	if (!can('sys_FileSystem.listFilesOfFileSystem'))
		return undefined;

	const roots = await discoverRoots();
	let current = (startDir ?? '').trim() || roots[0] || 'C:\\';

	for (let depth = 0; depth < BROWSE_MAX_DEPTH; depth++) {
		const entries = await listSubDirectories(current);

		if (!entries) {
			// 列目录不可用（缺接口 / 超时 / 异常）——交给下一档「手填路径」
			notifyWarn(
				[
					t('无法列出目录内容，将改用手动填写路径。'),
					'',
					`${t('目录')}: ${current}`,
					'',
					t('该接口需要「外部交互」权限；若已开启仍无响应，请重启 EasyEDA 客户端后重试。'),
				].join('\n'),
				t('PCB Delivery Export — 选择输出目录'),
			);
			return undefined;
		}

		const options: Array<{ value: string; displayContent: string }> = [];
		options.push({ value: BROWSE_PREFIX.use, displayContent: `${t('✅ 就用这个目录：')}${current}` });

		const parent = parentOf(current);
		if (parent)
			options.push({ value: BROWSE_PREFIX.up, displayContent: t('⬆ 上一级') });

		if (entries.length === 0) {
			options.push({ value: '__empty__', displayContent: t('（此目录下没有子文件夹）') });
		}
		else {
			for (const entry of entries.slice(0, BROWSE_MAX_ENTRIES))
				options.push({ value: `${BROWSE_PREFIX.dir}${entry.fullPath}`, displayContent: `📁 ${entry.name}` });
			if (entries.length > BROWSE_MAX_ENTRIES) {
				// 不写插值：t() 的 tag 必须是稳定字面量，才能被 locales 同步脚本提取
				options.push({
					value: '__more__',
					displayContent: t('（子文件夹过多，仅显示部分；其余请用手动填写路径）'),
				});
			}
		}

		options.push({ value: BROWSE_PREFIX.manual, displayContent: t('✏️ 手动输入路径') });
		if (roots.length > 1)
			options.push({ value: BROWSE_PREFIX.root, displayContent: t('💾 换一个磁盘 / 根目录') });

		const after = [
			'',
			`${t('当前目录')}: ${current}`,
		].join('\n');

		const picked = await selectAsync(
			options,
			t('逐级浏览文件夹，选中目标目录后点「✅ 就用这个目录」。'),
			after,
			t('PCB Delivery Export — 选择输出目录'),
			BROWSE_PREFIX.use,
		);

		if (!picked)
			return undefined; // 用户取消
		if (picked === BROWSE_PREFIX.use)
			return { dir: current, how: 'browse(listFilesOfFileSystem)' };
		if (picked === BROWSE_PREFIX.up) {
			if (parent)
				current = parent;
			continue;
		}
		if (picked === BROWSE_PREFIX.manual)
			return undefined; // 交回给手填路径
		if (picked === BROWSE_PREFIX.root) {
			const rootOptions = roots.map(r => ({ value: r, displayContent: r }));
			const chosenRoot = await selectAsync(
				rootOptions,
				t('选择一个起始磁盘 / 根目录：'),
				'',
				t('PCB Delivery Export — 选择磁盘'),
				roots[0],
			);
			if (chosenRoot)
				current = chosenRoot;
			continue;
		}
		if (picked.startsWith(BROWSE_PREFIX.dir)) {
			current = picked.slice(BROWSE_PREFIX.dir.length);
			continue;
		}
		// 无法识别的选项（例如占位项 `__empty__`）：停在当前目录继续浏览
	}

	notifyWarn(t('浏览层级过深，已停止。请改用手动填写路径。'), t('PCB Delivery Export — 选择输出目录'));
	return undefined;
}

/* ------------------------------------------------------------------ *
 * 输出目录解析（五级降级链）
 *
 * ## 为什么需要降级链（真实事故）
 * 第一版直接调用 `sys_FileSystem.openReadFolderPathDialog()` 选目录。
 * 该接口在用户客户端（EasyEDA Pro 3.2.149）上**不存在**，
 * 于是「选择输出目录」这一步直接失败，整个导出无从谈起。
 *
 * ## 五级方案
 * | 级别 | 接口 | 用户体验 |
 * |------|------|---------|
 * | 1 | `openReadFolderPathDialog` | 原生目录选择框（最佳） |
 * | 2 | `openReadFilePathDialog` → 取所在目录 | 原生文件选择框（选任意文件，用其所在文件夹） |
 * | 3 | **逐级浏览**（`listFilesOfFileSystem`） | 盘符 → 逐级进子目录 → 选中（旧版客户端的主力方案） |
 * | 4 | `showInputDialog` | 手填 / 粘贴绝对路径（可预填默认值） |
 * | 5 | `getDocumentsPath` + `/PCB_Delivery` | 全自动兜底，无需用户操作 |
 *
 * 关键点：**精确区分「用户取消」与「接口不可用」**——
 * 前者要尊重用户（保留上次目录），后者才能继续降级。
 * ------------------------------------------------------------------ */

/** 输出目录解析结果 */
export interface ResolvedDirectory {
	/** 目录绝对路径 */
	dir: string;
	/** 目录来源（稳定英文标识，写入导出报告便于事后追查） */
	how: string;
}

/**
 * 解析最终输出目录。
 *
 * @param current 上次记住的目录（可能为空）
 * @param reason  `user` = 用户主动勾选了「更换输出目录」；`missing` = 尚无目录，必须确定一个
 * @returns 无法确定时返回 `undefined`（调用方应终止导出并给出提示）
 */
/**
 * 取 `File` 对象上的绝对路径。
 * Electron 会给 File 附加 `path`；没有就返回空串，调用方据此继续降级。
 */
function absolutePathOfFile(file: unknown): string {
	if (!file || typeof file !== 'object')
		return '';
	const path = (file as { path?: unknown }).path;
	return typeof path === 'string' ? path.trim() : '';
}

/**
 * 从 `openReadFolderDialog()` 的结果反推文件夹绝对路径。
 *
 * 该接口返回 `Array<{ relativePath: string; file: File }>` —— **不含文件夹路径**。
 * 只能由 `file.path`（形如 `D:\root\sub\a.txt`）去掉尾部的 `relativePath`
 * （形如 `sub/a.txt`）得到 `D:\root`。拿不到就返回空串，让调用方继续降级。
 */
function folderFromPickEntries(entries: unknown): string {
	if (!Array.isArray(entries) || entries.length === 0)
		return '';
	const first = entries[0] as { relativePath?: unknown; file?: unknown; path?: unknown; fullPath?: unknown } | undefined;
	if (!first)
		return '';

	// 类型声明是包装对象，但部分真机实现直接返回 File[]；两种形态都兼容。
	const file = first.file ?? first;
	const wrappedPath = typeof first.path === 'string'
		? first.path
		: (typeof first.fullPath === 'string' ? first.fullPath : '');
	const abs = absolutePathOfFile(file) || wrappedPath.trim();
	if (!abs)
		return '';

	const normAbs = abs.replace(/\//g, '\\');
	const fileRelativePath = file && typeof file === 'object'
		? (file as { webkitRelativePath?: unknown }).webkitRelativePath
		: '';
	const rawRel = typeof first.relativePath === 'string' ? first.relativePath : fileRelativePath;
	const rel = typeof rawRel === 'string' ? rawRel.replace(/\//g, '\\') : '';
	if (rel) {
		const tail = `\\${rel}`;
		if (normAbs.length > tail.length
			&& normAbs.slice(-tail.length).toLowerCase() === tail.toLowerCase()) {
			return normAbs.slice(0, normAbs.length - tail.length);
		}
	}
	return dirnameOf(normAbs);
}

export async function resolveOutputDirectory(
	current: string,
	reason: 'user' | 'missing',
): Promise<ResolvedDirectory | undefined> {
	const currentDir = (current ?? '').trim();
	const caps = getCapabilities();

	if (reason === 'missing')
		logInfo('尚未配置输出目录，启动目录解析降级链（选择框 → 文件框 → 输入框 → 兜底目录）。');
	else
		logInfo(`用户主动更换输出目录，上次目录：${currentDir || '(无)'}`);

	// 延迟求值的默认目录：只有在需要时才去问 EDA 文档目录，避免拖慢前两档
	let defaultDirCache: string | undefined;
	let defaultDirAsked = false;
	const suggestedDefault = async (): Promise<string> => {
		if (!defaultDirAsked) {
			defaultDirAsked = true;
			const docs = await softCall(
				'sys_FileSystem.getDocumentsPath',
				FS_TIMEOUT_MS,
				() => eda.sys_FileSystem.getDocumentsPath(),
				'',
			);
			const docsDir = (docs ?? '').trim();
			defaultDirCache = docsDir ? joinPath(docsDir, 'PCB_Delivery') : '';
		}
		return defaultDirCache ?? '';
	};

	/** 用户取消时的统一收尾：有历史目录就沿用，没有则继续降级 */
	const onCancelled = (): ResolvedDirectory | undefined =>
		currentDir ? { dir: currentDir, how: 'cancelled(keep previous)' } : undefined;

	// ---------- 级别 1：官方原生目录选择框 ----------
	if (caps['sys_FileSystem.openReadFolderPathDialog']) {
		const outcome = await attempt(
			'sys_FileSystem.openReadFolderPathDialog',
			FOLDER_API_TIMEOUT_MS,
			() => eda.sys_FileSystem.openReadFolderPathDialog(),
		);
		if (outcome.ok) {
			const dir = (outcome.value ?? '').trim();
			if (dir)
				return { dir, how: 'openReadFolderPathDialog' };
			const kept = onCancelled();
			if (kept)
				return kept;
		}
	}

	// ---------- 级别 2：文件路径选择框 → 取其所在目录 ----------
	if (caps['sys_FileSystem.openReadFilePathDialog']) {
		const outcome = await attempt(
			'sys_FileSystem.openReadFilePathDialog',
			FOLDER_API_TIMEOUT_MS,
			() => eda.sys_FileSystem.openReadFilePathDialog(undefined, false),
		);
		if (outcome.ok) {
			const picked = typeof outcome.value === 'string' ? outcome.value : undefined;
			const dir = dirnameOf(picked);
			if (dir)
				return { dir, how: 'openReadFilePathDialog(dirname)' };
			const kept = onCancelled();
			if (kept)
				return kept;
		}
	}

	// ---------- 级别 2b：文件夹选择框（旧客户端有此接口，但只回 File 不回路径） ----------
	// 用户机器实测：openReadFolderPathDialog 缺失，而 openReadFolderDialog 存在。
	// 后者返回 Array<{relativePath, file}>，需要由 file.path 反推文件夹绝对路径。
	if (caps['sys_FileSystem.openReadFolderDialog']) {
		const outcome = await attempt(
			'sys_FileSystem.openReadFolderDialog',
			FOLDER_API_TIMEOUT_MS,
			() => eda.sys_FileSystem.openReadFolderDialog(),
		);
		if (outcome.ok) {
			const dir = folderFromPickEntries(outcome.value);
			if (dir)
				return { dir, how: 'openReadFolderDialog' };
			const kept = onCancelled();
			if (kept)
				return kept;
		}
	}

	// 不再退回 openReadFileDialog：那会强迫用户先选一个无关文件，体验上并不是
	// “选择输出目录”。文件夹接口没有给出绝对路径时，继续用内置目录浏览器/手填。

	// ---------- 级别 3：逐级浏览文件夹（旧版客户端的主力方案） ----------
	// 用户明确要求「存储路径应该是浏览的，不是添的」。本机若没有原生选择框，
	// 就用官方列目录接口拼一个真正的逐级浏览器；它不可用时才退回手填。
	if (can('sys_FileSystem.listFilesOfFileSystem')) {
		const browsed = await browseForDirectory(currentDir || undefined);
		if (browsed)
			return browsed;
		const kept = onCancelled();
		if (kept)
			return kept;
	}

	// ---------- 级别 4：文本输入框 ----------
	if (caps['sys_Dialog.showInputDialog']) {
		const fallbackValue = currentDir || await suggestedDefault();
		const typed = await inputAsync(
			t('当前 EasyEDA 版本不支持目录选择框，请直接填写或粘贴输出目录的绝对路径。'),
			[
				t('例如：D:\\PCB_Output'),
				fallbackValue
					? `${t('留空并确定 = 使用：')}${fallbackValue}`
					: t('留空并确定 = 使用 EDA 文档目录下的 PCB_Delivery'),
			].join('\n'),
			t('PCB Delivery Export — 选择输出目录'),
			fallbackValue,
		);
		if (typed)
			return { dir: typed, how: 'showInputDialog(manual)' };
		const kept = onCancelled();
		if (kept)
			return kept;
	}

	// ---------- 级别 5：全自动兜底 ----------
	const fallbackDir = await suggestedDefault();
	if (fallbackDir) {
		if (reason === 'user') {
			// 用户明确想换目录，但本机确实没有任何可用的选择通道：
			// 如实说明「不是我不给选，是这个版本没这个接口」，并指出可用的替代方式。
			notifyWarn(
				[
					t('当前 EasyEDA 版本没有可用的目录选择接口，无法指定其它目录。'),
					'',
					`${t('本次将使用：')}${fallbackDir}`,
					'',
					t('可在配置窗口的「浏览」里逐级选择目录；若该窗口也不可用，请把「接口连通性实测」的报告发给我们。'),
				].join('\n'),
				t('PCB Delivery Export'),
			);
		}
		return { dir: fallbackDir, how: 'fallback(Documents/PCB_Delivery)' };
	}

	// 走到这里说明连「EDA 文档目录」都问不到（能力与权限双双缺失）
	notifyError(
		[
			t('当前 EasyEDA 环境无法确定输出目录，导出已终止。'),
			'',
			t('可能原因：'),
			'  · 未启用扩展的「外部交互」权限（扩展管理器 → 已安装 → 本扩展）；',
			'  · 正在使用浏览器版 EasyEDA（无法写入本地目录，请改用客户端）。',
		].join('\n'),
		t('PCB Delivery Export'),
	);
	return undefined;
}

/* ------------------------------------------------------------------ *
 * 配置流程
 * ------------------------------------------------------------------ */

/** 配置流程的产出 */
export interface ConfigResult {
	settings: DeliverySettings;
	/** 输出目录的来源说明（写入导出报告的 ENVIRONMENT 段） */
	dirSource: string;
}

/** 配置流程的完成回调；用户取消时不会被调用 */
export type ConfigResultHandler = (result: ConfigResult) => void;

/* ------------------------------------------------------------------ *
 * A. 自定义配置窗口（sys_IFrame）
 * ------------------------------------------------------------------ */

/** 配置窗口在扩展包内的路径（打包时随 .eext 安装，见 /iframe/ 目录） */
const CONFIG_IFRAME_PATH = '/iframe/config.html';

/** 配置窗口 ID（openIFrame / closeIFrame 共用） */
const CONFIG_IFRAME_ID = 'pcb-delivery-config';

/** 配置窗口尺寸（正文内联框架的宽高） */
const CONFIG_IFRAME_WIDTH = 480;
const CONFIG_IFRAME_HEIGHT = 640;

/** 等待窗口心跳的上限：超时说明 IFrame 没活起来（如旧客户端未注入 eda） */
const HEARTBEAT_TIMEOUT_MS = 10_000;

/** 菜单点击后配置窗口必须在 5 秒内出现。 */
const IFRAME_OPEN_TIMEOUT_MS = 4_000;

/** 轮询存储桥的间隔 */
const POLL_INTERVAL_MS = 250;

/**
 * 当前客户端版本（取不到时返回空串）。
 * 仅用于「桥曾失败」标记是否仍然适用 —— 升级过客户端就重新试一次自定义窗口。
 */
function currentEdaVersion(): string {
	try {
		const raw = eda.sys_Environment.getEditorCurrentVersion();
		return typeof raw === 'string' ? raw : '';
	}
	catch {
		return '';
	}
}

/**
 * 自定义窗口桥是否已在当前客户端版本上确认不可用。
 * 为真时不再弹自定义窗口 —— 直接走官方弹窗链，避免用户反复看到同一个坏窗口。
 */
function isIframeBroken(): boolean {
	const marker = readJsonConfig(UI_BROKEN_KEY);
	if (!marker || typeof marker !== 'object')
		return false;
	const version = (marker as { version?: unknown }).version;
	if (typeof version !== 'string' || version === '')
		return false;
	// 版本取不到（''）时也算「不匹配」—— 不因为一次取版本失败就永久禁用窗口
	return version === currentEdaVersion();
}

/** 记下「桥在当前版本上不可用」 */
function markIframeBroken(): void {
	writeJsonConfig(UI_BROKEN_KEY, { version: currentEdaVersion(), at: Date.now() });
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => globalThis.setTimeout(resolve, ms));
}

/** iframe 配置流程的结果分类 */
type IframeOutcome
	= | { kind: 'ok'; result: ConfigResult }
		| { kind: 'cancelled' }
		| { kind: 'unavailable' };

/** iframe 写回的结果载荷（与 /iframe/config.html 约定） */
interface IframeResultPayload {
	selected?: unknown;
	outputDir?: unknown;
}

interface IframeBrowseRequest {
	id?: unknown;
	currentDir?: unknown;
}

/**
 * 打开自定义配置窗口并等待用户操作。
 *
 * 协议（详见 /iframe/config.html 头部注释）：
 *   主脚本写 `delivery-ui-request` → 打开窗口 → 窗口写 `delivery-ui-alive`（心跳）
 *   → 用户点「开始导出」后窗口写 `delivery-ui-result` 并自关；
 *   用户点 ✕ = 取消（无 result）。
 *
 * 三种结局：
 *   - `ok`          用户确认，携带解析后的配置；
 *   - `cancelled`   窗口活着但用户关闭了它 —— 尊重用户，什么都不做；
 *   - `unavailable` 窗口打不开 / 没有心跳 / 桥不可用 —— 调用方回退弹窗链。
 */
async function openConfigIframe(settings: DeliverySettings): Promise<IframeOutcome> {
	// 桥本身写不进去 = iframe 传不回数据，直接判不可用
	//
	// ⚠️ 勾选状态必须用「选项键」传（`cplFilter` / `schematicPdf` …），
	// 不能直接丢 `DeliverySettings`（键名是 `cplFilterEnabled` / `exportSchematicPdf` …）。
	// 两者键名不同，直接传会让窗口永远显示默认值 —— 保存的勾选看起来「没生效」。
	const request = {
		settings: { ...settings },
		selected: currentSelection(settings),
		outputDir: (settings.outputDir ?? '').trim(),
		iframeId: CONFIG_IFRAME_ID,
		interactiveBomSupported: IS_INTERACTIVE_BOM_SUPPORTED,
		folderPathPickerSupported: getCapabilities()['sys_FileSystem.openReadFolderPathDialog'],
	};
	// 桥写不进去 = 窗口传不回数据。判据是「写后读回一致」而不是返回值
	// （Promise/boolean/undefined 三种返回形态都见过，见 settings.ts 的说明）。
	if (!await writeJsonConfigVerified(UI_REQUEST_KEY, request)) {
		logWarn('sys_Storage 写入后读回不一致，自定义配置窗口不可用。');
		markIframeBroken();
		return { kind: 'unavailable' };
	}
	clearJsonConfig(UI_RESULT_KEY);
	clearJsonConfig(UI_ALIVE_KEY);
	clearJsonConfig(UI_BROWSE_REQUEST_KEY);
	clearJsonConfig(UI_BROWSE_RESULT_KEY);
	clearJsonConfig(UI_PROGRESS_KEY);

	// 用户点标题栏 ✕ 时由 openIFrame 的 buttonCallbackFn 通知（'close'）
	let closeSignal = false;
	// eslint（no-unmodified-loop-condition）看不出回调会改它，用函数间接读取
	const isClosed = (): boolean => closeSignal;

	// 打开窗口（openIFrame 返回 Promise<boolean>；也套硬超时防挂起）
	let opened: unknown = false;
	try {
		opened = await withTimeout(
			Promise.resolve(eda.sys_IFrame.openIFrame(
				CONFIG_IFRAME_PATH,
				CONFIG_IFRAME_WIDTH,
				CONFIG_IFRAME_HEIGHT,
				CONFIG_IFRAME_ID,
				{
					title: t('PCB Delivery Export — 导出设置'),
					buttonCallbackFn: (button) => {
						if (button === 'close')
							closeSignal = true;
					},
				},
			)),
			IFRAME_OPEN_TIMEOUT_MS,
			'sys_IFrame.openIFrame',
		);
	}
	catch (error) {
		logWarn(`sys_IFrame.openIFrame 不可用：${describeError(error)}`);
		markIframeBroken();
		return { kind: 'unavailable' };
	}
	if (opened !== true) {
		logWarn(`sys_IFrame.openIFrame 返回 ${String(opened)}，自定义配置窗口不可用。`);
		markIframeBroken();
		return { kind: 'unavailable' };
	}

	// 等心跳：证明 iframe 真的加载起来、能访问 eda 与存储
	let alive = false;
	const heartbeatDeadline = Date.now() + HEARTBEAT_TIMEOUT_MS;
	while (Date.now() < heartbeatDeadline && !isClosed()) {
		if (readJsonConfig(UI_ALIVE_KEY) !== undefined) {
			alive = true;
			break;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	if (!alive) {
		try {
			await withTimeout(
				Promise.resolve(eda.sys_IFrame.closeIFrame(CONFIG_IFRAME_ID)),
				IFRAME_OPEN_TIMEOUT_MS,
				'sys_IFrame.closeIFrame',
			);
		}
		catch {
			/* 关不掉也不影响回退 */
		}
		logWarn('配置窗口没有心跳（窗口未加载 / 未注入 eda / 存储桥不通），回退为官方弹窗流程。');
		// 记下失败：同一客户端版本下不再重复弹出这个打不通的窗口
		// （用户反馈「关闭重开还是这样」——每次点菜单都再弹一次失败的窗口）
		markIframeBroken();
		return { kind: 'unavailable' };
	}

	// 等用户操作：结果写回 or 用户关闭窗口
	const waitDeadline = Date.now() + PICKER_TIMEOUT_MS;
	while (!isClosed()) {
		const browse = readJsonConfig(UI_BROWSE_REQUEST_KEY) as IframeBrowseRequest | undefined;
		if (browse && typeof browse === 'object' && typeof browse.id === 'number') {
			clearJsonConfig(UI_BROWSE_REQUEST_KEY);
			const currentDir = typeof browse.currentDir === 'string' ? browse.currentDir : settings.outputDir;
			const picked = await resolveOutputDirectory(currentDir, 'user');
			writeJsonConfig(UI_BROWSE_RESULT_KEY, {
				id: browse.id,
				dir: picked?.dir ?? '',
				how: picked?.how ?? 'cancelled',
			});
		}

		const raw = readJsonConfig(UI_RESULT_KEY) as IframeResultPayload | undefined;
		if (raw && typeof raw === 'object') {
			clearJsonConfig(UI_RESULT_KEY);
			clearJsonConfig(UI_ALIVE_KEY);
			clearJsonConfig(UI_REQUEST_KEY);

			const selected = Array.isArray(raw.selected)
				? raw.selected.filter((v): v is string => typeof v === 'string')
				: [];
			const next = applySelection(settings, selected);

			const typed = typeof raw.outputDir === 'string' ? raw.outputDir.trim() : '';
			const previous = (settings.outputDir ?? '').trim();
			if (typed && typed.toLowerCase() !== previous.toLowerCase()) {
				next.outputDir = typed;
				return {
					kind: 'ok',
					result: { settings: next, dirSource: 'iframe(user-selected)' },
				};
			}
			if (typed) {
				next.outputDir = typed;
				return { kind: 'ok', result: { settings: next, dirSource: 'iframe(remembered)' } };
			}
			// 窗口没带回目录（理论上被前端校验拦住，防御性处理）→ 回退弹窗链
			return { kind: 'unavailable' };
		}
		if (Date.now() > waitDeadline) {
			notifyWarn(t('配置窗口长时间没有返回结果，已按取消处理。'), t('PCB Delivery Export'));
			break;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	// 用户主动关闭 = 取消导出
	clearJsonConfig(UI_RESULT_KEY);
	clearJsonConfig(UI_REQUEST_KEY);
	logInfo('用户关闭了配置窗口，导出已取消。');
	return { kind: 'cancelled' };
}

/* ------------------------------------------------------------------ *
 * B. 官方弹窗链（回退路径）
 * ------------------------------------------------------------------ */

/**
 * 必选项说明（恒定导出，不可取消）。
 *
 * 刻意压成**一行**：窗口里的复选框列表如果上方文字太长，整个列表就会被挤出可视区，
 * 用户必须滚动才能看到全部选项（用户实测反馈：「选项被折叠/要滚动」）。
 */
function mandatoryNote(): string {
	return `${t('必选（始终导出）：')} Gerber · BOM · ${t('坐标文件 CPL')}`;
}

/** 输出目录与版本能力说明 */
function outputNote(settings: DeliverySettings, pickerAvailable: boolean): string {
	const dir = (settings.outputDir ?? '').trim();
	const lines: string[] = [];
	lines.push('');
	lines.push(dir ? `${t('当前输出目录：')}${dir}` : `${t('尚未设置输出目录，确定后将引导你选择。')}`);
	if (!pickerAvailable) {
		lines.push('');
		lines.push(
			can('sys_FileSystem.listFilesOfFileSystem')
				? t('注：当前 EasyEDA 版本没有原生目录选择框，改用「逐级浏览文件夹」选择目录。')
				: t('注：当前 EasyEDA 版本既无原生目录选择框也无列目录接口，只能手填路径。'),
		);
	}
	return lines.join('\n');
}

/**
 * 构建可选项列表。
 *
 * 每一项都刻意做成**一行短标签**（不再附加括号说明、不再加 `[分类]` 前缀）：
 * 用户实测反馈旧版客户端里选项会被折叠、需要滚动才能看全。
 * 需要解释的内容一律挪到窗口下方的说明区，不挤占列表高度。
 */
function buildOptionList(settings: DeliverySettings): Array<{ value: string; displayContent: string }> {
	const make = (key: OptionKey, label: string): { value: string; displayContent: string } =>
		({ value: key, displayContent: label });

	const currentDir = (settings.outputDir ?? '').trim();
	const changeLabel = currentDir
		? `${t('输出目录…')}  (${currentDir})`
		: `${t('选择输出目录…')}`;

	const list = [
		make(OPTION_KEYS.cplFilter, t('CPL 按 BOM 过滤')),
		make(OPTION_KEYS.schematicPdf, t('原理图 PDF')),
		make(OPTION_KEYS.step, t('STEP 3D 模型')),
	];

	if (IS_INTERACTIVE_BOM_SUPPORTED) {
		list.push(make(OPTION_KEYS.interactiveBom, t('交互式 BOM')));
	}

	list.push(
		make(OPTION_KEYS.projectV3, t('工程文件 V3  (.epro2)')),
		make(OPTION_KEYS.projectV2, t('工程文件 V2  (.epro)')),
		make(OPTION_KEYS.runDrc, t('导出前运行 DRC')),
		make(OPTION_KEYS.changeOutputDir, changeLabel),
	);

	return list;
}

/** 依据当前设置算出默认勾选项 */
function currentSelection(settings: DeliverySettings): string[] {
	const selected: string[] = [];
	if (settings.cplFilterEnabled)
		selected.push(OPTION_KEYS.cplFilter);
	if (settings.exportSchematicPdf)
		selected.push(OPTION_KEYS.schematicPdf);
	if (settings.exportStep)
		selected.push(OPTION_KEYS.step);
	if (settings.exportInteractiveBom && IS_INTERACTIVE_BOM_SUPPORTED)
		selected.push(OPTION_KEYS.interactiveBom);
	if (settings.exportProjectV3)
		selected.push(OPTION_KEYS.projectV3);
	if (settings.exportProjectV2)
		selected.push(OPTION_KEYS.projectV2);
	if (settings.runDrc)
		selected.push(OPTION_KEYS.runDrc);
	// 「更换输出目录」是动作项，不预勾选
	return selected;
}

/** 依据勾选结果回填设置 */
function applySelection(settings: DeliverySettings, selected: string[]): DeliverySettings {
	const has = (key: string): boolean => selected.includes(key);

	const next: DeliverySettings = {
		...settings,
		// 必选项恒定开启
		exportGerber: true,
		exportBom: true,
		exportCpl: true,
		// 3D HTML 恒为 false（官方 API 不支持）
		export3DHtml: false,

		// CPL 过滤是**可选项**，默认勾选（用户要求）
		cplFilterEnabled: has(OPTION_KEYS.cplFilter),

		exportSchematicPdf: has(OPTION_KEYS.schematicPdf),
		exportStep: has(OPTION_KEYS.step),
		exportInteractiveBom: has(OPTION_KEYS.interactiveBom),
		exportProjectV3: has(OPTION_KEYS.projectV3),
		exportProjectV2: has(OPTION_KEYS.projectV2),
		runDrc: has(OPTION_KEYS.runDrc),
	};

	return next;
}

/** 未支持能力的说明文字：明确标注原因，而不是假装能选 */
function unsupportedNote(): string {
	const lines: string[] = [];
	if (!IS_3D_HTML_SUPPORTED) {
		lines.push('');
		lines.push(`3D HTML  (Current EasyEDA API does not support this export)`);
		lines.push(t('该项目前不可导出：官方 Extension API 未提供 3D HTML 导出接口。'));
	}
	return lines.join('\n');
}

/**
 * 启动完整配置流程。
 *
 * 优先走**自定义窗口**（平铺复选框 + 浏览按钮，用户明确要求）；
 * 该窗口在本机不可用（接口缺失 / 窗口死了 / 桥不通）时自动回退官方弹窗链。
 *
 * @param settings 上次保存的设置
 * @param onDone   配置完成回调（用户取消时不会被调用）
 */
export function startConfigFlow(settings: DeliverySettings, onDone: ConfigResultHandler): void {
	const iframePossible = can('sys_IFrame.openIFrame')
		&& can('sys_IFrame.closeIFrame')
		&& can('sys_Storage.getExtensionUserConfig')
		&& can('sys_Storage.setExtensionUserConfig');

	if (!iframePossible) {
		startDialogConfigFlow(settings, onDone);
		return;
	}

	// 同一客户端版本上桥已确认不通 → 不再重复弹那个坏窗口（用户反馈「关闭重开还是这样」）
	if (isIframeBroken()) {
		logWarn('自定义配置窗口在当前客户端版本上已确认不可用，直接使用官方弹窗流程。');
		startDialogConfigFlow(settings, onDone);
		return;
	}
	void openConfigIframe(settings).then((outcome) => {
		if (outcome.kind === 'ok') {
			onDone(outcome.result);
			return;
		}
		if (outcome.kind === 'cancelled')
			return; // 尊重用户：什么都不做
		// unavailable → 回退
		logWarn('自定义配置窗口不可用，回退为官方弹窗流程。');
		startDialogConfigFlow(settings, onDone);
	});
}

/** 官方弹窗链（回退路径）：`showSelectDialog` 多选 + 目录降级链 */
function startDialogConfigFlow(settings: DeliverySettings, onDone: ConfigResultHandler): void {
	const pickerAvailable = getCapabilities()['sys_FileSystem.openReadFolderPathDialog'];

	try {
		eda.sys_Dialog.showSelectDialog(
			buildOptionList(settings),
			mandatoryNote(),
			`${outputNote(settings, pickerAvailable)}${unsupportedNote()}`,
			t('PCB Delivery Export — 导出设置'),
			currentSelection(settings),
			true,
			(selectedValues: string[]) => {
				const selected = Array.isArray(selectedValues) ? selectedValues : [];
				const next = applySelection(settings, selected);

				const wantsChange = selected.includes(OPTION_KEYS.changeOutputDir);
				const needsDir = (next.outputDir ?? '').trim().length === 0;

				if (!wantsChange && !needsDir) {
					onDone({ settings: next, dirSource: 'remembered(previous)' });
					return;
				}

				// 走目录降级链，选完再继续
				void resolveOutputDirectory(next.outputDir, wantsChange ? 'user' : 'missing')
					.then((picked) => {
						if (!picked) {
							notifyError(
								t('未能确定输出目录，本次导出已取消。'),
								t('PCB Delivery Export'),
							);
							return;
						}
						onDone({
							settings: { ...next, outputDir: picked.dir },
							dirSource: picked.how,
						});
					});
			},
		);
	}
	catch (error) {
		notifyError(
			`${t('无法显示配置窗口，导出已终止。')}\n\n${describeError(error)}`,
			t('PCB Delivery Export'),
		);
	}
}

/* ------------------------------------------------------------------ *
 * 导出过程中的交互
 * ------------------------------------------------------------------ */

/**
 * DRC 未通过时的确认框。
 *
 * @returns true = 仍然导出；false = 取消导出
 */
export async function confirmDrcFailure(drc: DrcResult): Promise<boolean> {
	const lines: string[] = [];
	lines.push(t('DRC检查未通过'));
	lines.push('');
	lines.push(`${t('条目总数')}: ${drc.itemCount}`);
	if (drc.errorCount !== undefined)
		lines.push(`Errors: ${drc.errorCount}`);
	if (drc.unroutedCount !== undefined)
		lines.push(`Unrouted: ${drc.unroutedCount}`);
	if (drc.errorCount === undefined || drc.unroutedCount === undefined) {
		lines.push('');
		lines.push(t('（官方 DRC 返回结构未公开，无法可靠拆分 Errors / Unrouted，仅给出条目总数。）'));
	}
	lines.push('');
	lines.push(t('是否仍然继续导出？某些项目可能存在工程师已明确接受的 DRC 警告。'));

	// 弹窗失效时默认「仍然导出」：与「不强制阻断导出」的既定策略一致
	return confirmAsync(
		lines.join('\n'),
		t('PCB Delivery Export — DRC'),
		t('仍然导出'),
		t('取消导出'),
		true,
	);
}

/**
 * 进度提示（Toast），不打断操作。
 *
 * ⚠️ 第三个参数 `timer` 的单位是**秒**（`0` = 不自动关闭）。
 * 曾经按毫秒的直觉传了 `3000`，结果进度条挂了 50 分钟不消失。
 * 现在统一使用 `TOAST_SEC_PROGRESS`，并让下一条进度提示覆盖上一条。
 */
export function toastProgress(message: string, percent?: number): void {
	writeJsonConfig(UI_PROGRESS_KEY, { message, percent, at: Date.now() });
	try {
		eda.sys_Message.showToastMessage(message, undefined, TOAST_SEC_PROGRESS);
	}
	catch {
		/* 进度提示失败不影响导出 */
	}
}

/** 更新配置窗口里的确定进度条；窗口未打开时仅保留 Toast。 */
export function setExportProgress(percent: number, message: string): void {
	const value = Math.max(0, Math.min(100, Math.round(percent)));
	toastProgress(`[${value}%] ${message}`, value);
}

/** 导出结束时关闭仍停留在进度页的配置窗口。 */
export function finishExportProgress(message: string): void {
	writeJsonConfig(UI_PROGRESS_KEY, { percent: 100, message, done: true, at: Date.now() });
	try {
		eda.sys_IFrame.closeIFrame(CONFIG_IFRAME_ID);
	}
	catch {
		/* 传统弹窗流程没有 IFrame；无需处理 */
	}
}

/* ------------------------------------------------------------------ *
 * 结果展示
 * ------------------------------------------------------------------ */

/**
 * 导出完成后的结果窗口。
 *
 * 说明：官方 API **没有**「在资源管理器中打开目录」的接口
 * （`sys_Window.open(url)` 仅接受 URL，不是「打开本地文件夹」的能力），
 * 因此**不放置**「打开文件夹」按钮，避免做一个点了没反应的假按钮；
 * 改为在窗口中把**完整路径**醒目地列出来，用户可直接复制。
 */
export function showCompletion(run: ExportRunResult): void {
	notify(summarizeRun(run), t('Export Complete'));
}

/**
 * paths.ts —— 文件名 / 路径 / 日期目录 工具
 *
 * ## 这个模块为什么被整体重写（真实事故）
 *
 * 第一版把「判断目录是否存在 / 创建目录」写死成下面两个接口：
 *
 *     await eda.sys_FileSystem.existsPathInFileSystem(path);       // EDA v3.2.167 才引入
 *     await eda.sys_FileSystem.createDirectoryInFileSystem(path);  // EDA v3.2.166 才引入
 *
 * 用户客户端是 **EasyEDA Pro 3.2.149** —— 两个接口都还不存在，
 * 于是导出流程第一步就 `TypeError: ... is not a function`。
 *
 * 现在所有目录能力都改为**运行时探测 + 分级降级**，见下方 `createDeliveryDirectory`。
 */

import { can, getCapabilities } from './capabilities';
import {
	DELIVERABLE_WRITE_TIMEOUT_MS,
	describeError,
	DIR_PROBE_TIMEOUT_MS,
	ExportStepError,
	FS_TIMEOUT_MS,
	isTimeoutError,
	logInfo,
	logWarn,
	softCall,
	withTimeout,
} from './edaCompat';
import { buildPendingReportBlob, REPORT_FILE_NAME } from './report';

/** Windows 文件名/路径非法字符：\ / : * ? " < > | */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/** 日期格式化为本机 Local Date 的 YYYYMMDD（明确不使用 UTC）。 */
export function formatLocalDateYmd(date: Date = new Date()): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}${m}${d}`;
}

/** 本机可读时间戳，用于报告：YYYY-MM-DD HH:mm:ss */
export function formatLocalDateTime(date: Date = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
		+ `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * 把控制字符（U+0000–U+001F 与 U+007F）替换为 `_`。
 * 逐字符判断而非用正则：正则写法需要匹配控制字符范围，可读性差且容易被静态检查误报。
 */
function stripControlChars(input: string): string {
	let out = '';
	for (const ch of input) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7F ? '_' : ch;
	}
	return out;
}

/**
 * 把板名清洗为 Windows 安全的文件名片段。
 * 非法字符 `\ / : * ? " < > |` 替换为 `_`，并 Trim 前后空格与点。
 */
export function sanitizeName(rawName: string): string {
	let name = (rawName ?? '').replace(ILLEGAL_CHARS, '_');
	// 控制字符一并替换掉
	name = stripControlChars(name);
	// Windows 不允许文件名以空格或点结尾
	name = name.replace(/^[\s.]+|[\s.]+$/g, '');
	// 折叠连续下划线，保持整洁
	name = name.replace(/_{2,}/g, '_');
	return name.length > 0 ? name : 'PCB_Project';
}

/** 判断目录分隔符：含反斜杠的按 Windows 处理。 */
export function detectSeparator(dir: string): string {
	return dir.includes('\\') ? '\\' : '/';
}

/** 拼接目录与名称。 */
export function joinPath(dir: string, name: string): string {
	const sep = detectSeparator(dir);
	const base = dir.replace(/[\\/]+$/, '');
	return `${base}${sep}${name}`;
}

/**
 * 取一个文件路径的所在目录。
 * 用于「旧版客户端没有目录选择框」时的降级方案：让用户选任意一个文件，
 * 插件使用它所在的文件夹（见 ui.ts 的 `resolveOutputDirectory`）。
 */
export function dirnameOf(filePath: string | undefined | null): string {
	const p = (filePath ?? '').trim();
	if (!p)
		return '';
	const sep = detectSeparator(p);
	const idx = p.lastIndexOf(sep);
	if (idx <= 0)
		return '';
	const dir = p.slice(0, idx);
	// Windows 盘符根：`C:\a.txt` → `C:` 需要补回分隔符，否则 `C:` 是相对路径
	return /^[a-z]:$/i.test(dir) ? `${dir}${sep}` : dir;
}

/** 判断是否 Windows 绝对路径（`D:\...` 或 `\\server\...`）。 */
export function isWindowsAbsolutePath(p: string): boolean {
	return /^[a-z]:[\\/]/i.test(p) || /^\\\\/.test(p);
}

/** 基础路径校验：不允许空、盘符相对路径、上级目录穿越。 */
export function validateBaseDir(dir: string): string | undefined {
	const trimmed = (dir ?? '').trim();
	if (!trimmed)
		return 'EMPTY';
	if (trimmed.includes('\u0000'))
		return 'ILLEGAL_CHAR';
	// 相对路径 / 未指定盘符的路径无法可靠写入
	if (!isWindowsAbsolutePath(trimmed) && !trimmed.startsWith('/'))
		return 'NOT_ABSOLUTE';
	return undefined;
}

/* ------------------------------------------------------------------ *
 * 输出目录：自适应创建
 *
 * ## 三级判定策略
 *
 * 按当前客户端**实际拥有**的能力依次降级，最终采用的策略名会写进导出报告：
 *
 * | 策略 | 依赖接口 | 判定方式 | 精确度 |
 * |------|---------|---------|--------|
 * | `exist-check` | `existsPathInFileSystem`（≥ v3.2.167） | 直接问「这个路径存在吗」 | 精确 |
 * | `list-check`  | `listFilesOfFileSystem` | 列出父目录内容，看名字是否被占用 | 精确 |
 * | `write-probe` | 只要 `saveFileToFileSystem` | 用 `force=false` 写探测文件：返回 `false` 即已占用 | 可用 |
 *
 * 第三级是关键：即便用户缺失前两个接口，只要能写文件，
 * 就能凭「写不进去说明已被占用」这一事实做判断，
 * 因此**旧版客户端同样能做到不覆盖历史交付目录**。
 * ------------------------------------------------------------------ */

/** 目录版本号的判定策略（写入报告，便于事后追查） */
export type DirStrategy = 'exist-check' | 'list-check' | 'write-probe';

/** 输出目录选用的结果 */
export interface StagedDirectory {
	/** 最终目录绝对路径 */
	fullPath: string;
	/** 目录名（ProjectName_YYYYMMDD 或带 _02 后缀）；平铺降级时为空串 */
	baseName: string;
	/** 本次实际使用的判定策略 */
	strategy: DirStrategy;
	/** 需要写入报告的说明（例如降级提示） */
	notes: string[];
	/**
	 * **必须显示在完成窗口顶部**的关键说明。
	 *
	 * 只在「结果可能不符合用户预期」时才非空，例如输出目录被改写、
	 * 或退化为平铺输出 —— 否则用户会拿着「导出成功」的提示找不到文件。
	 */
	critical: string[];
	/**
	 * 是否退化为「直接输出到所选目录」。
	 *
	 * 正常模式会在所选目录下新建 `板名_YYYYMMDD` 子目录。
	 * 但本机若无 `createDirectoryInFileSystem`，且 `saveFileToFileSystem`
	 * 不会隐式创建父目录，则子目录**根本建不出来** ——
	 * 此时改为把文件直接写进所选目录，用带日期的文件名区分，
	 * 而不是反复重试同一个注定失败的写入。
	 */
	flat: boolean;
	/** 文件命名前缀：正常模式 = 板名；平铺模式 = `板名_YYYYMMDD` */
	filePrefix: string;
	/** 报告文件名；平铺/救援模式必须带本次前缀，避免覆盖旧报告。 */
	reportFileName: string;
}

/** 同一天最多尝试的版本号槽位（_02 … _999） */
const MAX_VERSION_SLOT = 999;

/**
 * 在**无法判定占用**（纯探测模式）时，连续失败多少次就认定不是命名冲突。
 *
 * 注意：只有在「占用与否无法判定」时才会换槽位重试。
 * 一旦能确认「该槽位是空的却还是写不进去」，就立刻停止 —— 那是环境问题，
 * 换 20 个槽位也只会得到 20 次相同的失败。
 */
const MAX_PROBE_FAILURES_BLIND = 3;

/**
 * ⚠️ 超时**一次就放弃**，绝不重试。
 *
 * 真实事故：用户客户端（EasyEDA 3.2.149）上 `sys_FileSystem.*` 这一族接口
 * 会**永久挂起**——既不返回 `false`，也不抛异常（实测 `getDocumentsPath()`
 * 超过 5000 ms 未返回，而「外部交互」权限确已开启）。
 * 老版本把「超时」和「目录已被占用」当成同一件事处理，于是：
 * 20 s 超时 × 20 次重试 = 最长 **400 秒** 的假死，
 * 用户看到的现象就是「卡在『正在创建输出目录…』，再也没有动静」。
 *
 * 超时与失败的性质完全不同：
 *   - 「目录已被占用」→ 换下一个槽位重试是**正确**的；
 *   - 「接口没响应」  → 换槽位重试毫无意义，只会把假死时间拉长。
 */
const MAX_PROBE_TIMEOUTS = 1;

/** 候选目录名：第 1 个不带后缀，之后依次 _02、_03 … */
function candidateName(base: string, index: number): string {
	return index <= 1 ? base : `${base}_${String(index).padStart(2, '0')}`;
}

/** 目录列表条目（只取用得上的三个字段，其余按官方结构忽略） */
export interface DirItem {
	name: string;
	isDirectory: boolean;
	fullPath?: string;
}

/** 列出目录条目；能力缺失或调用失败（含超时）时返回 undefined */
export async function listDirEntries(dir: string): Promise<DirItem[] | undefined> {
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

		const items: DirItem[] = [];
		for (const entry of entries) {
			const item = entry as {
				fileName?: unknown;
				isDirectory?: unknown;
				fullPath?: unknown;
			} | undefined;
			const name = typeof item?.fileName === 'string' ? item.fileName : '';
			if (!name)
				continue;
			items.push({
				name,
				isDirectory: item?.isDirectory === true,
				fullPath: typeof item?.fullPath === 'string' ? item.fullPath : undefined,
			});
		}
		return items;
	}
	catch (error) {
		logWarn(`listFilesOfFileSystem(${dir}) 失败：${describeError(error)}`);
		return undefined;
	}
}

/** 取上一级目录；已在根目录时返回 undefined */
function parentDirOf(dir: string): string | undefined {
	const trimmed = dir.replace(/[\\/]+$/, '');
	const sep = trimmed.includes('\\') ? '\\' : '/';
	const idx = trimmed.lastIndexOf(sep);
	if (idx <= 0)
		return undefined;
	const parent = trimmed.slice(0, idx);
	// `E:` → `E:\`，保证传回官方接口的始终是绝对路径
	return /^[a-z]:$/i.test(parent) ? `${parent}${sep}` : parent;
}

/**
 * 判断目录是否存在；**无法判定时返回 undefined**（与「不存在」严格区分）。
 *
 * 优先用 `existsPathInFileSystem`；没有该接口时，改为列出父目录逐项比对 ——
 * 这正是「本机只有列目录能力」时的等价手段。
 */
export async function directoryExists(dir: string): Promise<boolean | undefined> {
	if (can('sys_FileSystem.existsPathInFileSystem')) {
		try {
			return (await withTimeout(
				eda.sys_FileSystem.existsPathInFileSystem(dir),
				FS_TIMEOUT_MS,
				'existsPathInFileSystem',
			)) === true;
		}
		catch (error) {
			logWarn(`existsPathInFileSystem(${dir}) 失败：${describeError(error)}`);
			return undefined;
		}
	}

	if (!can('sys_FileSystem.listFilesOfFileSystem'))
		return undefined;

	const parent = parentDirOf(dir);
	if (!parent)
		return undefined; // 盘符根：无法用「列父目录」判定

	const items = await listDirEntries(parent);
	if (!items)
		return undefined;

	const sep = detectSeparator(dir);
	const target = dir.replace(/[\\/]+$/, '');
	const name = target.slice(target.lastIndexOf(sep) + 1).toLowerCase();

	return items.some((item) => {
		if (!item.isDirectory)
			return false;
		if (item.name.toLowerCase() === name)
			return true;
		const full = (item.fullPath ?? '').replace(/[\\/]+$/, '');
		return full.length > 0 && full.toLowerCase() === target.toLowerCase();
	});
}

/**
 * 探测写入的结果。
 *
 * 四类结果必须分开处理，混在一起就会出现「假死」：
 *   - `writable` 目录可写且槽位全新 → 用它；
 *   - `occupied` 返回 `false`，目录里已有同名交付文件 → **换下一个槽位重试**；
 *   - `timeout` 接口超过上限仍未返回 → **立即放弃**，重试没有意义；
 *   - `error`  接口抛异常（多为权限/路径问题）→ 有限次数重试后放弃。
 */
export type ProbeOutcome = 'writable' | 'occupied' | 'timeout' | 'error';

/** 一次探测写入的完整结果 */
export interface ProbeResult {
	outcome: ProbeOutcome;
	/** 人类可读的原始信息（超时/异常时用于报告与提示） */
	detail?: string;
}

/**
 * 探测写入：把占位报告写进候选目录，用返回值判断目录是否已被占用。
 *
 * `force = false` 是官方签名明确支持的行为：**文件已存在时返回 `false`**
 * （见 API_NOTES.md 第五节）。
 *
 * 占位文件用的就是报告文件名，导出成功时会被真正的报告覆盖，
 * 因此**不会在交付目录里留下任何多余文件**。
 */
export async function probeWritable(
	dirPath: string,
	force = false,
	fileName: string = REPORT_FILE_NAME,
): Promise<ProbeResult> {
	const probePath = joinPath(dirPath, fileName);
	try {
		// ⚠️ 第三个参数必须传 `undefined`（v1.4.0 真实事故）：
		// 官方备注明确「uri 结尾非斜杠时识别为完整文件名，此时 fileName 参数将被忽略」，
		// 传与不传语义相同；但在 EasyEDA 3.2.149 实测：
		//   · v1.2.0 传 `undefined`        → 秒回（连续 20 次都是立即返回 false）
		//   · v1.3.0 传显式 'Export_Report.txt' → 同一台机器、同样的路径上**永久挂起**
		// 探测必须用已被证实「有响应」的调用形态。
		const ok = await withTimeout(
			eda.sys_FileSystem.saveFileToFileSystem(
				probePath,
				buildPendingReportBlob(),
				undefined,
				force,
			),
			DIR_PROBE_TIMEOUT_MS,
			`saveFileToFileSystem(probe: ${probePath})`,
		);
		return { outcome: ok === true ? 'writable' : 'occupied' };
	}
	catch (error) {
		const detail = describeError(error);
		logWarn(`探测写入失败（${probePath}）：${detail}`);
		return { outcome: isTimeoutError(error) ? 'timeout' : 'error', detail };
	}
}

/** 尽力删除一个文件；失败也绝不抛出（清理动作不应影响主流程） */
async function deleteQuietly(fullPath: string): Promise<void> {
	try {
		const fn = eda.sys_FileSystem.deleteFileInFileSystem;
		if (typeof fn !== 'function')
			return;
		await withTimeout(
			Promise.resolve(fn.call(eda.sys_FileSystem, fullPath, false)),
			FS_TIMEOUT_MS,
			`deleteFileInFileSystem(${fullPath})`,
		);
	}
	catch (error) {
		logWarn(`清理探测文件失败（${fullPath}）：${describeError(error)}`);
	}
}

/** 尽力创建目录；能力缺失时静默跳过，交由写入接口隐式创建 */
async function tryCreateDirectory(dirPath: string): Promise<void> {
	if (!can('sys_FileSystem.createDirectoryInFileSystem'))
		return;
	try {
		await withTimeout(
			eda.sys_FileSystem.createDirectoryInFileSystem(dirPath),
			FS_TIMEOUT_MS,
			'createDirectoryInFileSystem',
		);
	}
	catch (error) {
		logWarn(`createDirectoryInFileSystem(${dirPath}) 失败，改用写入接口隐式创建：${describeError(error)}`);
	}
}

/**
 * 计算并创建本次交付目录。
 *
 * 规则：
 *   1. 目录名 = `{ProjectName}_{YYYYMMDD}`（本地日期，非 UTC）
 *   2. 已存在则依次尝试 `{...}_02`、`{...}_03` …（**绝不覆盖历史交付目录**）
 *   3. 判定策略随本机能力自动降级，并把实际策略写入报告
 *
 * @param rootDir  用户选择的基础输出目录
 * @param safeName 已清洗的板名
 */
export async function createDeliveryDirectory(rootDir: string, safeName: string): Promise<StagedDirectory> {
	const dateTag = formatLocalDateYmd(new Date());
	const base = `${safeName}_${dateTag}`;
	const notes: string[] = [];

	const caps = getCapabilities();
	const canExist = caps['sys_FileSystem.existsPathInFileSystem'];
	const canCreate = caps['sys_FileSystem.createDirectoryInFileSystem'];

	// EasyEDA Pro 3.2.149 真机确认：本机缺少建目录接口；完整文件路径形式会
	// 永久挂起，而「目录 URI + fileName」形式会错误地创建一个与目标目录同名的
	// 普通文件。两种隐式创建方式都不可用，因此绝不能再伪装成“目录已创建”。
	// 直接验证用户选择的现有目录并平铺输出，保证交付能够完成。
	if (!canCreate) {
		notes.push(
			'目录创建：本机无 createDirectoryInFileSystem；该旧客户端无法通过写入接口可靠创建文件夹，'
			+ '本次直接采用平铺输出。',
		);
		const intendedPath = joinPath(rootDir, base);
		const flat = await tryFlatFallback(
			rootDir,
			base,
			notes,
			'write-probe',
			intendedPath,
			`平铺输出：本机缺少 createDirectoryInFileSystem，且写入接口不能可靠创建日期子目录`
			+ `「${intendedPath}」（会挂起或误建成同名文件）。`,
		);
		if (flat)
			return flat;

		const rescue = await tryRescueDirectory(rootDir, base, notes, 'write-probe', intendedPath);
		if (rescue)
			return rescue;

		throw new ExportStepError(
			'Output Directory',
			`所选目录无法写入，且未找到可用的救援目录：${rootDir}`,
		);
	}

	// ---------- A. 基础目录预检 ----------
	// 这一条是真实事故换来的：用户选了一个还不存在的目录，
	// 老版本会去尝试 20 个日期子目录、次次失败，最后只丢出一句
	// 「已连续尝试 20 次」，完全看不出真正的原因其实是「父目录不存在」。
	//
	// 但预检绝不能「一言堂」：判定接口本身可能不准（个别版本恒返回 false），
	// 所以**最终的裁决权始终交给一次真实写入**——只有确实写不进去才报错。
	// 3.2.149 的 listFilesOfFileSystem 已确认会挂起。没有专用 exists API 时
	// 不再用“列父目录”做前置查询，直接进入真实写入探测。
	const rootExists = canExist ? await directoryExists(rootDir) : undefined;
	if (rootExists === false) {
		if (canCreate) {
			// 能建目录：建完再看一次；仍然报不存在也不判死，交给写入探测裁决
			await tryCreateDirectory(rootDir);
			const again = await directoryExists(rootDir);
			if (again === false) {
				notes.push(
					`基础目录预检：${rootDir} 被判定为不存在，且创建后仍如此；`
					+ '已继续尝试写入，以实际写入结果为准。',
				);
			}
		}
		else {
			// 建不了目录：直接写一次，用结果说话（用临时文件名，写完删掉）
			const probeName = '__pcb_delivery_probe.tmp';
			const rootProbe = await probeWritable(rootDir, true, probeName);
			if (rootProbe.outcome !== 'writable') {
				const parent = dirnameOf(rootDir);
				const parentItems = parent ? await listDirEntries(parent) : undefined;
				const siblings = parentItems
					? parentItems.filter(i => i.isDirectory).map(i => i.name).slice(0, 8)
					: [];
				const lines = [
					`输出目录不存在且无法创建：${rootDir}`,
					rootProbe.detail ? `写入探测结果：${rootProbe.detail}` : '',
					'',
					'本插件无法替你创建这个目录，原因有两条：',
					'  · 本机缺少 createDirectoryInFileSystem（EDA v3.2.166 才引入）；',
					'  · 而写入接口只负责写文件，不会隐式创建多级目录。',
					'',
					'请先在资源管理器中手动创建这个文件夹，然后重新导出一次。',
				];
				if (siblings.length > 0)
					lines.push('', `同级已有的文件夹（供核对）：${siblings.join('、')}`);

				throw new ExportStepError('Output Directory', lines.filter(l => l.length > 0).join('\n'));
			}
			await deleteQuietly(joinPath(rootDir, probeName));
			notes.push(
				`基础目录预检：判定接口认为 ${rootDir} 不存在，但实测可以写入，已按可写继续。`,
			);
		}
	}
	else if (rootExists === undefined) {
		notes.push('基础目录预检：本机无可用判定接口（既无 existsPathInFileSystem 也无法列父目录），已跳过。');
	}

	// ---------- B. 判定策略 ----------
	const strategy: DirStrategy = canExist ? 'exist-check' : 'write-probe';

	if (strategy === 'write-probe') {
		notes.push(
			'目录占用判定：使用「写入探测」实现（本机无 existsPathInFileSystem；'
			+ '为避免查询接口挂起，不调用 listFilesOfFileSystem）。先写入探测文件，返回 false 即视为该目录已被历史交付占用，'
			+ '随后改用 _02、_03 … 后缀。',
		);
	}
	if (!canCreate) {
		notes.push(
			'目录创建：本机无 createDirectoryInFileSystem（EDA v3.2.166 引入），'
			+ '改由 saveFileToFileSystem 隐式创建父目录。',
		);
	}

	let probeFailures = 0;
	let probeTimeouts = 0;

	/** 「这个槽位根本建不出来 / 写不进去」的证据路径 —— 一旦拿到就停止换槽位 */
	let blockedPath: string | undefined;
	let lastDetail: string | undefined;

	for (let index = 1; index <= MAX_VERSION_SLOT; index++) {
		const chosen = candidateName(base, index);
		const fullPath = joinPath(rootDir, chosen);

		// A. 占用判定（三态：true=已占用 / false=确认空闲 / undefined=无法判定）
		let occupied: boolean | undefined;
		if (canExist) {
			try {
				occupied = (await withTimeout(
					eda.sys_FileSystem.existsPathInFileSystem(fullPath),
					FS_TIMEOUT_MS,
					'existsPathInFileSystem',
				)) === true;
			}
			catch {
				occupied = undefined; // 判定不了就当「未知」，交给写入探测裁决
			}
		}
		if (occupied === true)
			continue;

		// B. 尽力创建目录（缺该能力时依赖写入接口隐式创建）
		await tryCreateDirectory(fullPath);

		// C. 最终以「能不能真的写进去」为准。
		//    ⚠️ 顺序很重要：必须**先写一次**，失败后再判定原因。
		//    反过来「先判定子目录不存在就直接放弃」是错的 ——
		//    很多客户端的写入接口会隐式创建父目录，那样的机器上本可以正常导出。
		const probe = await probeWritable(fullPath);

		if (probe.outcome === 'writable') {
			logInfo(`Delivery directory ready (strategy=${strategy}): ${fullPath}`);
			return {
				fullPath,
				baseName: chosen,
				strategy,
				notes,
				critical: [],
				flat: false,
				filePrefix: safeName,
				reportFileName: REPORT_FILE_NAME,
			};
		}

		// C-1. 超时：一次就放弃（详见 MAX_PROBE_TIMEOUTS 的说明）。
		//      放在「再查一次目录」之前：既然写入接口已经没响应，
		//      再调一次列目录只会多浪费一个超时周期。
		if (probe.outcome === 'timeout') {
			probeTimeouts++;
			if (probeTimeouts >= MAX_PROBE_TIMEOUTS) {
				throw new ExportStepError(
					'Output Directory',
					[
						`写入接口没有响应，导出已终止（${probe.detail ?? '超时'}）。`,
						'',
						`目标目录：${rootDir}`,
						'',
						'这说明本机 EasyEDA 的「文件系统」接口调用了却一直不返回，',
						'而不是目标目录有问题。常见原因与处理：',
						'  · 重启 EasyEDA 客户端后重试（该族接口偶发卡在首次调用）；',
						'  · 确认「扩展管理器 → 已安装 → 本扩展 → 外部交互」已勾选，并重启客户端；',
						'  · 换一个输出目录再试（例如从网络盘/同步盘换到本地磁盘）；',
						'  · 运行「接口连通性实测」菜单，查看每个接口的真实响应耗时，把结果发给我们以便定位。',
						'',
						'已确认可用的接口清单见「环境自检」菜单；各接口的真实响应耗时见「接口连通性实测」。',
					].join('\n'),
				);
			}
			continue;
		}

		// 明确异常不是“文件已存在”，换槽位没有意义；直接验证所选根目录。
		if (probe.outcome === 'error') {
			blockedPath = fullPath;
			lastDetail = probe.detail;
			break;
		}

		// C-2. 写不进去，且本机没有建目录接口：
		//      看看子目录到底有没有被隐式建出来。
		//      没建出来 ⇒ 换多少个槽位都是同样的结果，立刻停止（这正是
		//      「已连续尝试 20 次」那次事故的关键判定）。
		if (!canCreate && canExist) {
			const created = await directoryExists(fullPath);
			if (created === false) {
				blockedPath = fullPath;
				break;
			}
		}

		probeFailures++;
		lastDetail = probe.detail;

		// D-2. 已经确认「这个槽位是空闲的」却还是写不进去
		//      ⇒ 这不是命名冲突，而是「根本写不了」，换槽位毫无意义
		if (occupied === false) {
			blockedPath = fullPath;
			break;
		}

		// D-3. 无法判定占用（纯探测模式）：`false` 可能是「被占用」，
		//      换槽位还有意义，但要有上限，不能空转 20 次
		if (probeFailures >= MAX_PROBE_FAILURES_BLIND) {
			blockedPath = fullPath;
			break;
		}
	}

	// ---------- E. 子目录建不出来 → 退化为「平铺输出」，保证用户拿到文件 ----------
	if (blockedPath) {
		const flat = await tryFlatFallback(rootDir, base, notes, strategy, blockedPath);
		if (flat)
			return flat;
	}

	// ---------- E-2. 连所选目录本身都写不了 → 换一个「救援目录」 ----------
	// 真实场景中相当常见的一种成因：输出路径含中文（例如 `...\POE传感器\输出`），
	// 个别旧版本客户端在此类路径上写入直接失败。此时与其让用户一无所获，
	// 不如改写到官方提供的、通常为纯 ASCII 的目录下，并在报告与结果窗口里如实说明。
	const rescue = await tryRescueDirectory(
		rootDir,
		base,
		notes,
		strategy,
		blockedPath ?? joinPath(rootDir, base),
	);
	if (rescue)
		return rescue;

	// ---------- F. 其余情况：给出可操作的诊断 ----------
	const hints = [
		'常见原因：',
		'  · 未在「扩展管理器 → 已安装 → 本扩展」中启用「外部交互」权限（改动后需重启客户端）；',
		'  · 目标路径位于只读位置、网络盘/同步盘，或当前用户没有写权限；',
		'  · 目录被其它程序独占占用。',
	];
	if (!canCreate) {
		hints.push(
			'  · 本机 EasyEDA 缺少 createDirectoryInFileSystem（EDA v3.2.166 引入），',
			'    子目录需由写入接口隐式创建；若该行为不成立，请手动创建文件夹后重试。',
		);
	}
	if (hasNonAscii(rootDir)) {
		hints.push(
			'  · 输出路径含有中文/非 ASCII 字符，个别旧版本客户端在此类路径上写入会失败；',
			'    可先换一个纯英文路径试一次，以确认是否为该原因。',
		);
	}

	const message = [
		`无法写入输出目录：${rootDir}`,
		blockedPath ? `最后一次尝试的目录：${blockedPath}` : '',
		lastDetail ? `原始信息：${lastDetail}` : '',
		'',
		...hints,
		'',
		'可照做的一步：在资源管理器中手动创建上面那个文件夹，然后重新导出一次。',
		'详细的原始错误已写入 EDA 日志面板（搜索关键字 PCB Delivery）。',
	].filter(line => line.length > 0).join('\n');

	throw new ExportStepError('Output Directory', message);
}

/** 路径中是否含非 ASCII 字符（用于给出「换纯英文路径试一次」的提示） */
function hasNonAscii(value: string): boolean {
	for (const ch of value) {
		if (ch.codePointAt(0)! > 0x7F)
			return true;
	}
	return false;
}

/**
 * 平铺输出降级：把文件直接写进所选目录，用**带日期的文件名**区分。
 *
 * 触发条件：日期子目录确实创建不出来（本机无建目录接口，且写入接口不隐式创建父目录）。
 * 与其让用户一无所获，不如退一步把文件交出去，并在报告里如实写明这一点。
 *
 * 文件名前缀会带上日期（并避开已存在的前缀），因此**不同日期的导出不会互相覆盖**。
 */
async function tryFlatFallback(
	rootDir: string,
	base: string,
	notes: string[],
	strategy: DirStrategy,
	blockedPath: string,
	reason?: string,
): Promise<StagedDirectory | undefined> {
	let prefix = base;
	let reportFileName = `${prefix}_${REPORT_FILE_NAME}`;
	let last: ProbeResult | undefined;
	for (let index = 1; index <= MAX_PROBE_FAILURES_BLIND; index++) {
		prefix = candidateName(base, index);
		reportFileName = `${prefix}_${REPORT_FILE_NAME}`;
		last = await probeWritable(rootDir, false, reportFileName);
		if (last.outcome === 'writable')
			break;
		if (last.outcome === 'timeout') {
			throw new ExportStepError('Output Directory', `平铺写入接口没有响应：${last.detail ?? '超时'}`);
		}
		if (last.outcome === 'error')
			break;
	}
	if (last?.outcome !== 'writable') {
		logWarn(`平铺降级也失败（${rootDir}）：${last?.detail ?? last?.outcome ?? 'unknown'}`);
		return undefined;
	}

	const flatReason = reason ?? [
		'平铺输出：本机无法创建日期子目录（缺少 createDirectoryInFileSystem，',
		`且写入接口不隐式创建父目录；失败的目录为「${blockedPath}」）。`,
	].join('');
	const flatNote = `${flatReason}文件已直接输出到所选目录，文件名前缀为「${prefix}」以区分不同日期的导出。`;

	logInfo(`Flat fallback in use: ${rootDir} (prefix=${prefix})`);
	return {
		fullPath: rootDir,
		baseName: '',
		strategy,
		notes,
		critical: [flatNote],
		flat: true,
		filePrefix: prefix,
		reportFileName,
	};
}

/**
 * 救援目录：当**所选目录整体不可写**时，改写到官方给出的目录。
 *
 * ## 为什么要这一步
 *
 * 用户的失败路径是 `E:\work\fiverr\260922_aguepe6_POE传感器\输出`（含中文）。
 * 旧版客户端在含非 ASCII 字符的路径上写入会直接失败，
 * 而此时换任何日期子目录都没有用 —— 这正是「已连续尝试 20 次」的成因之一。
 *
 * 与其让用户一无所获，这里改为写入官方提供的目录（通常是纯 ASCII 路径），
 * 并在报告与结果窗口里**明确写出改到了哪里、为什么改**。
 *
 * 注意：本机若无 `createDirectoryInFileSystem`，`PCB_Delivery` 子目录也建不出来，
 * 因此候选清单里同时包含「官方目录本身」，逐个探测、取第一个真的能写的。
 */
async function tryRescueDirectory(
	rootDir: string,
	base: string,
	notes: string[],
	strategy: DirStrategy,
	failedPath?: string,
): Promise<StagedDirectory | undefined> {
	const roots: Array<{ path: string; label: string }> = [];

	const push = async (label: string, fn: () => Promise<string>): Promise<void> => {
		const value = await softCall(
			label,
			FS_TIMEOUT_MS,
			fn,
			'',
		);
		const dir = (value ?? '').trim();
		if (!dir)
			return;
		roots.push({ path: dir, label });
		roots.push({ path: joinPath(dir, 'PCB_Delivery'), label: `${label}/PCB_Delivery` });
	};

	if (can('sys_FileSystem.getDocumentsPath'))
		await push('sys_FileSystem.getDocumentsPath', () => eda.sys_FileSystem.getDocumentsPath());
	if (can('sys_FileSystem.getEdaPath'))
		await push('sys_FileSystem.getEdaPath', () => eda.sys_FileSystem.getEdaPath());

	for (const candidate of roots) {
		// 与已经失败过的目录相同就没有再试的意义
		if (candidate.path.toLowerCase() === rootDir.replace(/[\\/]+$/, '').toLowerCase())
			continue;

		await tryCreateDirectory(candidate.path);
		const reportFileName = `${base}_${REPORT_FILE_NAME}`;
		const probe = await probeWritable(candidate.path, false, reportFileName);
		if (probe.outcome !== 'writable') {
			logWarn(`救援目录不可写（${candidate.path}）：${probe.detail ?? probe.outcome}`);
			continue;
		}

		const note = [
			`⚠ 输出目录已改写：原目录「${rootDir}」无法写入`,
			`（最后一次尝试：${failedPath ?? '—'}；原始信息：${probe.detail ?? '未知'}）。`,
			`文件已改为输出到「${candidate.path}」（来源：${candidate.label}），`,
			`文件名以「${base}」为前缀以区分不同日期的导出。`,
			'若原路径含中文，这通常是个别旧版本客户端在非 ASCII 路径上的写入限制；换一个纯英文输出目录即可恢复正常模式。',
		].join('');

		logInfo(`Rescue directory in use: ${candidate.path} (from ${candidate.label})`);
		return {
			fullPath: candidate.path,
			baseName: '',
			strategy,
			notes,
			critical: [note],
			flat: true,
			filePrefix: base,
			reportFileName,
		};
	}

	return undefined;
}

/**
 * 把 File/Blob 写入指定目录。
 * 直接传**完整文件路径**（结尾不带分隔符），避免 `fileName` 参数被忽略带来的歧义。
 *
 * 这里套了一个**很宽松**的超时（默认 5 分钟）：正常导出远快于此，
 * 它的唯一作用是防止「接口无声挂起」把整个流程永久卡死。
 *
 * @returns 写入后的完整路径
 */
export async function writeFileToDir(dirPath: string, fileName: string, data: File | Blob): Promise<string> {
	const fullPath = joinPath(dirPath, fileName);

	let ok = false;
	try {
		// ⚠️ 第三个参数传 `undefined`：官方备注明确「uri 结尾非斜杠时识别为完整文件名，
		// 此时 fileName 参数将被忽略」，文件名由 fullPath 决定，不受影响。
		// 实测（EasyEDA 3.2.149）：传显式 fileName 的调用形态会永久挂起，见 probeWritable 注释。
		ok = await withTimeout(
			eda.sys_FileSystem.saveFileToFileSystem(fullPath, data, undefined, true),
			DELIVERABLE_WRITE_TIMEOUT_MS,
			`saveFileToFileSystem(${fileName})`,
		);
	}
	catch (error) {
		throw new ExportStepError(
			`Write: ${fileName}`,
			`写入文件失败：${describeError(error)}`,
			error,
		);
	}

	if (!ok) {
		throw new ExportStepError(`Write: ${fileName}`, `写入文件返回 false：${fullPath}`);
	}

	return fullPath;
}

/** 从 File 对象上取扩展名（含点，小写）。 */
export function getFileExtension(file: File | undefined | null): string {
	const name = file?.name ?? '';
	const idx = name.lastIndexOf('.');
	if (idx < 0)
		return '';
	return name.slice(idx).toLowerCase();
}

/** 从 File 对象上取文件名。 */
export function getFileName(file: File | undefined | null): string {
	return file?.name ?? '';
}

/**
 * 选择扩展名：优先沿用官方返回文件的扩展名，取不到时用 fallback。
 * 用于 Gerber：官方返回值可能已经是 .zip，也可能是别的容器，保持原样最安全。
 */
export function pickExtension(file: File | undefined | null, fallback: string): string {
	const ext = getFileExtension(file);
	if (ext && ext.length <= 8 && /^\.[a-z0-9]+$/.test(ext))
		return ext;
	return fallback;
}

/**
 * capabilities.ts —— 官方 API 的**运行时能力探测**
 *
 * ## 为什么必须有这一层（真实事故复盘）
 *
 * 用户客户端为 **EasyEDA Pro 3.2.149.88089769**，而插件第一版把「创建日期目录 /
 * 检查目录是否存在 / 选择输出目录」三件事全部压在下面三个接口上：
 *
 * | 接口 | 引入版本（类型定义中的 `ADD since EDA vX`） | 用户 3.2.149 上 |
 * |------|------------------------------------------|----------------|
 * | `createDirectoryInFileSystem` | **v3.2.166** | 不存在 |
 * | `existsPathInFileSystem` | **v3.2.167** | 不存在 |
 * | `openReadFolderPathDialog` | 无标注（`@alpha`） | 不存在 |
 *
 * 于是导出流程第一步就 `TypeError: ... is not a function`。
 *
 * ## 为什么不能靠静态分析解决
 *
 * `@jlceda/pro-api-types`（本项目为 `0.4.25`）描述的是**最新版** API 面，
 * 该包覆盖到 **EDA v4.1.13**，比用户客户端超前一年多。而版本标注本身也不可靠：
 *
 * - `ADD since EDA vX` 标注的是**某条重载声明**加入的版本，不等于该名字首次出现的版本。
 *   例如 `getEditorCurrentVersion` 标注 `v3.2.176`，但实测在 3.2.149 上**已经可用**。
 * - 并非所有新增接口都带标注，例如 `openReadFolderPathDialog` 就没有任何标注。
 *
 * 结论：**某个接口在用户机器上到底存不存在，只能运行时问一次。**
 * 本模块就是那个「问一次」的地方，结果被缓存，供全流程按可用能力选择降级路径。
 *
 * ## 设计原则
 *
 * 1. 只做属性读取，不做任何业务动作 —— 探测本身绝不能抛异常。
 * 2. 结果缓存，避免反复取值；提供 `invalidateCapabilities()` 供测试重置。
 * 3. 清单与元数据（分组 / 是否核心 / 降级行为 / 引入版本）集中在这里，
 *    自检报告与业务代码共用同一份，不再重复维护第二份列表。
 */

/* 本模块刻意**不依赖任何其它模块**：它是全流程的地基，
   若它自己需要 import，就会给「探测能力」这件事引入额外的不确定性。 */

/* ------------------------------------------------------------------ *
 * 清单
 * ------------------------------------------------------------------ */

/**
 * 本插件会用到（部分为可选）的全部官方 API。
 * 键名采用 `访问器.方法` 的形式，便于直接打印进诊断报告。
 */
export const CAPABILITY_KEYS = [
	// ---- 通知 / 弹窗 ----
	'sys_Dialog.showInformationMessage',
	'sys_Dialog.showConfirmationMessage',
	'sys_Dialog.showSelectDialog',
	'sys_Dialog.showInputDialog',
	'sys_Message.showToastMessage',
	'sys_MessageBox.showInformationMessage',
	// ---- 窗口 / 界面 ----
	'sys_IFrame.openIFrame',
	'sys_IFrame.closeIFrame',
	// ---- 环境 / 存储 ----
	'sys_Environment.isClient',
	'sys_Environment.isWeb',
	'sys_Environment.getEditorCurrentVersion',
	'sys_Storage.getExtensionUserConfig',
	'sys_Storage.setExtensionUserConfig',
	'sys_Log.add',
	// ---- 本地文件系统 ----
	'sys_FileSystem.getDocumentsPath',
	'sys_FileSystem.getEdaPath',
	'sys_FileSystem.getProjectsPaths',
	'sys_FileSystem.saveFile',
	'sys_FileSystem.saveFileToFileSystem',
	'sys_FileSystem.createDirectoryInFileSystem',
	'sys_FileSystem.existsPathInFileSystem',
	'sys_FileSystem.listFilesOfFileSystem',
	'sys_FileSystem.readFileFromFileSystem',
	'sys_FileSystem.deleteFileInFileSystem',
	'sys_FileSystem.openReadFolderDialog',
	'sys_FileSystem.openReadFolderPathDialog',
	'sys_FileSystem.openReadFileDialog',
	'sys_FileSystem.openReadFilePathDialog',
	// ---- 工程 / 文档 ----
	'dmt_Board.getCurrentBoardInfo',
	'dmt_Pcb.getPcbInfo',
	'dmt_Project.getCurrentProjectInfo',
	'dmt_SelectControl.getCurrentDocumentInfo',
	'sys_FileManager.getProjectFile',
	// ---- 制造文件 ----
	'pcb_ManufactureData.getGerberFile',
	'pcb_ManufactureData.getBomFile',
	'pcb_ManufactureData.getPickAndPlaceFile',
	'pcb_ManufactureData.get3DFile',
	'pcb_ManufactureData.getInteractiveBomFile',
	'sch_ManufactureData.getExportDocumentFile',
	'pcb_Drc.check',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** 探测结果表：每个键对应该接口是否存在 */
export type CapabilityMap = Record<CapabilityKey, boolean>;

/** 单项能力的说明元数据 */
export interface CapabilityMeta {
	/** 自检报告中的分组标题 */
	group: string;
	/**
	 * 是否为**无可替代**的核心能力：
	 * 为 true 表示该接口缺失时对应功能彻底不可用；
	 * 为 false 表示插件有降级路径，缺失只影响体验而不影响可用性。
	 */
	critical?: boolean;
	/** 缺失时的降级行为（写入自检报告，让用户知道还能不能用） */
	fallback?: string;
	/** 引入该接口的 EDA 版本（仅当类型定义中有明确标注时才写） */
	since?: string;
}

/** 分组顺序（自检报告按此顺序输出，避免依赖对象键顺序） */
export const CAPABILITY_GROUPS = [
	'通知 / 弹窗',
	'窗口 / 界面',
	'环境 / 存储',
	'本地文件系统',
	'工程 / 文档',
	'制造文件',
] as const;

/**
 * 清单元数据。
 *
 * `critical` 的判定标准是「有没有替代路径」，不是「重不重要」——
 * 例如 `existsPathInFileSystem` 看着很核心，但它有三级降级（见 paths.ts），
 * 所以标记为非核心；而 `saveFileToFileSystem` 是唯一的本地写入通道，
 * 缺失就真的没有别的办法，标为核心。
 */
export const CAPABILITY_META: Record<CapabilityKey, CapabilityMeta> = {
	'sys_Dialog.showInformationMessage': {
		group: '通知 / 弹窗',
		fallback: '改用 sys_MessageBox → Toast → window.alert → console 的降级链（notify.ts）',
	},
	'sys_Dialog.showConfirmationMessage': {
		group: '通知 / 弹窗',
		fallback: 'DRC 未通过时按「仍然导出」继续，并在报告中记录',
	},
	'sys_Dialog.showSelectDialog': {
		group: '通知 / 弹窗',
		critical: true,
		fallback: '无替代路径：这是唯一的导出配置窗口',
	},
	'sys_Dialog.showInputDialog': {
		group: '通知 / 弹窗',
		fallback: '改用 EDA 文档目录下的 PCB_Delivery 作为输出目录',
	},
	'sys_Message.showToastMessage': {
		group: '通知 / 弹窗',
	},
	'sys_MessageBox.showInformationMessage': {
		group: '通知 / 弹窗',
	},
	'sys_IFrame.openIFrame': {
		group: '窗口 / 界面',
		fallback: '改用官方弹窗链（showSelectDialog 多选）完成配置',
	},
	'sys_IFrame.closeIFrame': {
		group: '窗口 / 界面',
		fallback: '改用官方弹窗链（showSelectDialog 多选）完成配置',
	},
	'sys_Environment.isClient': { group: '环境 / 存储' },
	'sys_Environment.isWeb': { group: '环境 / 存储' },
	'sys_Environment.getEditorCurrentVersion': { group: '环境 / 存储' },
	'sys_Storage.getExtensionUserConfig': {
		group: '环境 / 存储',
		fallback: '改用 localStorage；再失败则本次导出使用默认设置',
	},
	'sys_Storage.setExtensionUserConfig': {
		group: '环境 / 存储',
		fallback: '改用 localStorage；再失败则设置无法记忆',
	},
	'sys_Log.add': { group: '环境 / 存储' },

	'sys_FileSystem.getDocumentsPath': {
		group: '本地文件系统',
		fallback: '输出目录兜底不可用，需要用户手填绝对路径',
	},
	'sys_FileSystem.getEdaPath': { group: '本地文件系统' },
	'sys_FileSystem.getProjectsPaths': { group: '本地文件系统' },
	'sys_FileSystem.saveFile': { group: '本地文件系统' },
	'sys_FileSystem.saveFileToFileSystem': {
		group: '本地文件系统',
		critical: true,
		fallback: '无替代路径：这是唯一的批量写入本地目录的通道',
	},
	'sys_FileSystem.createDirectoryInFileSystem': {
		group: '本地文件系统',
		since: 'v3.2.166',
		fallback: '直接平铺输出；旧客户端会把目录 URI 误建成普通文件',
	},
	'sys_FileSystem.existsPathInFileSystem': {
		group: '本地文件系统',
		since: 'v3.2.167',
		fallback: '改用 listFilesOfFileSystem 列目录；再不可用则改用写入探测（force=false）',
	},
	'sys_FileSystem.listFilesOfFileSystem': {
		group: '本地文件系统',
		fallback: '改用写入探测（force=false）判断目录是否已被占用',
	},
	'sys_FileSystem.readFileFromFileSystem': { group: '本地文件系统' },
	'sys_FileSystem.deleteFileInFileSystem': { group: '本地文件系统' },
	'sys_FileSystem.openReadFolderDialog': { group: '本地文件系统' },
	'sys_FileSystem.openReadFolderPathDialog': {
		group: '本地文件系统',
		fallback: '改用 openReadFolderDialog 或内置逐级浏览；再不可用则手填路径',
	},
	'sys_FileSystem.openReadFileDialog': { group: '本地文件系统' },
	'sys_FileSystem.openReadFilePathDialog': {
		group: '本地文件系统',
		fallback: '改用 showInputDialog 让用户输入/粘贴路径',
	},

	'dmt_Project.getCurrentProjectInfo': {
		group: '工程 / 文档',
		fallback: '最后的命名回退值使用 PCB_Board',
	},
	'dmt_Board.getCurrentBoardInfo': {
		group: '工程 / 文档',
		fallback: '改用当前 PCB 文档名；再不可用则回退到工程名',
	},
	'dmt_Pcb.getPcbInfo': {
		group: '工程 / 文档',
		fallback: '改用当前板名或工程名',
	},
	'dmt_SelectControl.getCurrentDocumentInfo': {
		group: '工程 / 文档',
		fallback: '跳过「请先打开 PCB 文档」前置检查，直接进入配置窗口',
	},
	'sys_FileManager.getProjectFile': {
		group: '工程 / 文档',
		fallback: '工程源文件步骤记为 FAILED，不影响其它文件',
	},

	'pcb_ManufactureData.getGerberFile': {
		group: '制造文件',
		critical: true,
		fallback: '无替代路径：Gerber 为必选项',
	},
	'pcb_ManufactureData.getBomFile': {
		group: '制造文件',
		critical: true,
		fallback: '无替代路径：BOM 为必选项',
	},
	'pcb_ManufactureData.getPickAndPlaceFile': {
		group: '制造文件',
		critical: true,
		fallback: '无替代路径：坐标文件为必选项',
	},
	'pcb_ManufactureData.get3DFile': {
		group: '制造文件',
		fallback: 'STEP 步骤记为 FAILED，不影响其它文件',
	},
	'pcb_ManufactureData.getInteractiveBomFile': {
		group: '制造文件',
		fallback: '交互式 BOM 步骤记为 FAILED，不影响其它文件',
	},
	'sch_ManufactureData.getExportDocumentFile': {
		group: '制造文件',
		fallback: '原理图 PDF 步骤记为 FAILED，不影响其它文件',
	},
	'pcb_Drc.check': {
		group: '制造文件',
		fallback: '跳过 DRC 前置检查，直接导出，并在报告中记录',
	},
};

/** 获得完整功能建议达到的最低 EDA 版本 */
export const RECOMMENDED_EDA_VERSION = '3.2.167';

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/**
 * 取到官方 API 的根对象。
 *
 * 优先直接引用全局 `eda`（类型定义中声明为全局常量），
 * 若注入方式不同则退回 `globalThis.eda`。
 * 两种都拿不到时返回 `undefined`，由调用方按「全部能力缺失」处理。
 */
function edaRoot(): Record<string, unknown> | undefined {
	try {
		// `typeof` 对未声明的标识符是安全的，不会抛 ReferenceError
		if (typeof eda !== 'undefined' && eda)
			return eda as unknown as Record<string, unknown>;
	}
	catch {
		/* 落到 globalThis 兜底 */
	}
	try {
		const viaGlobal = (globalThis as unknown as Record<string, unknown>).eda;
		if (viaGlobal && typeof viaGlobal === 'object')
			return viaGlobal as Record<string, unknown>;
	}
	catch {
		/* ignore */
	}
	return undefined;
}

/**
 * 按 `访问器.方法` 的路径逐级取值，判断末级是否为函数。
 * 路径中任意一环缺失（例如 `sys_FileSystem` 本身不存在）都会被收敛为 `false`。
 *
 * 中间层同时接受 `object` 与 `function`：类实例是 object，但某些实现会把
 * 命名空间暴露成带属性的函数。多接受一种形态只会提高探测成功率。
 */
function probeKey(key: string): boolean {
	try {
		const root = edaRoot();
		if (!root)
			return false;

		const segments = key.split('.');
		let cursor: unknown = root;
		for (const segment of segments) {
			const isTraversable = cursor !== null && cursor !== undefined
				&& (typeof cursor === 'object' || typeof cursor === 'function');
			if (!isTraversable)
				return false;
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return typeof cursor === 'function';
	}
	catch {
		return false;
	}
}

/** 探测结果缓存 */
let cache: CapabilityMap | undefined;

/**
 * 探测全部官方 API 的存在性（结果缓存）。
 *
 * 纯属性读取，**不会抛异常、不会发起任何真实调用**。
 */
export function getCapabilities(): CapabilityMap {
	if (cache)
		return cache;

	const map = {} as CapabilityMap;
	for (const key of CAPABILITY_KEYS) {
		try {
			map[key] = probeKey(key);
		}
		catch {
			map[key] = false;
		}
	}

	cache = map;
	return map;
}

/** 清除缓存（测试用；正常流程中能力在单次会话内不会变化） */
export function invalidateCapabilities(): void {
	cache = undefined;
}

/** 单项查询的语法糖 */
export function can(key: CapabilityKey): boolean {
	return getCapabilities()[key] === true;
}

/** 当前缺失的能力清单（按 CAPABILITY_KEYS 顺序） */
export function missingCapabilities(): CapabilityKey[] {
	const map = getCapabilities();
	return CAPABILITY_KEYS.filter(key => !map[key]);
}

/** 当前缺失的**核心**能力清单（没有替代路径的那些） */
export function missingCriticalCapabilities(): CapabilityKey[] {
	return missingCapabilities().filter(key => CAPABILITY_META[key]?.critical === true);
}

/* ------------------------------------------------------------------ *
 * 版本工具
 * ------------------------------------------------------------------ */

/** 把 `3.2.149.88089769` 解析为 `[3, 2, 149]`（只取前 3 段，忽略构建号） */
export function parseEdaVersion(version: string): [number, number, number] | undefined {
	const parts = (version ?? '').trim().split('.');
	if (parts.length < 2)
		return undefined;
	const nums: number[] = [];
	for (let i = 0; i < 3; i++) {
		const n = Number.parseInt(parts[i] ?? '0', 10);
		if (!Number.isFinite(n))
			return undefined;
		nums.push(n);
	}
	return [nums[0], nums[1], nums[2]];
}

/** 版本比较：`current >= target` */
export function isVersionAtLeast(current: string, target: string): boolean {
	const a = parseEdaVersion(current);
	const b = parseEdaVersion(target);
	if (!a || !b)
		return false;
	for (let i = 0; i < 3; i++) {
		if (a[i] > b[i])
			return true;
		if (a[i] < b[i])
			return false;
	}
	return true;
}

/**
 * 给用户的版本说明。
 *
 * 注意措辞：**不要断言「升级就能解决」** —— 用户实测其客户端已是官方渠道最新版
 * （3.2.149），而接口可用性与版本渠道相关，类型定义里的 `ADD since` 标注并不可靠。
 * 这里只如实说明「缺了什么、插件如何降级」，把选择权交给用户。
 */
export function versionAdvice(edaVersion: string): string[] {
	const lines: string[] = [];
	const lacksVersionGated = !can('sys_FileSystem.createDirectoryInFileSystem')
		|| !can('sys_FileSystem.existsPathInFileSystem')
		|| !can('sys_FileSystem.openReadFolderPathDialog');

	if (!lacksVersionGated)
		return lines;

	const versionLine = edaVersion
		? `本机 EasyEDA（版本 ${edaVersion}）未提供部分官方目录管理接口（接口可用性与客户端版本/渠道有关，不是插件缺陷）。`
		: '本机 EasyEDA 未提供部分官方目录管理接口（接口可用性与客户端版本/渠道有关，不是插件缺陷）。';
	lines.push(versionLine);
	lines.push('插件已自动启用兼容降级路径，功能可以正常使用：');
	lines.push('  · createDirectoryInFileSystem —— 缺失时直接平铺输出，避免把目标目录误建成普通文件');
	lines.push('  · existsPathInFileSystem     —— 缺失时改用列目录 / 写入探测');
	lines.push('  · openReadFolderPathDialog   —— 缺失时改用文件夹选择框 / 内置逐级浏览，最后手填');
	return lines;
}

/**
 * types.ts —— 插件内部的共享类型
 */

/** 工程源文件格式（已核实：V3 → epro2，V2 → epro，见 API_NOTES.md 第三节） */
export type ProjectFormat = 'V3' | 'V2';

/** 通知级别（notify.ts 使用） */
export type NotifyKind = 'info' | 'warn' | 'error';

/** 用户可配置项（会持久化到 EDA 扩展存储） */
export interface DeliverySettings {
	/**
	 * 制造文件：Gerber / BOM / CPL。
	 * 这三项为**必选项**（用户需求：「gerber，bom 和坐标文件是默认必选的」），
	 * 恒为 `true`，在配置窗口里不出现在可选列表中，也不会被取消。
	 */
	exportGerber: boolean;
	exportBom: boolean;
	exportCpl: boolean;
	/** CPL 依据 BOM 过滤（删除 BOM 中不存在的元件） */
	cplFilterEnabled: boolean;
	/** 设计文档 */
	exportSchematicPdf: boolean;
	exportStep: boolean;
	/** 交互式 BOM（HTML）—— 官方 `getInteractiveBomFile` 提供，标注为 @internal */
	exportInteractiveBom: boolean;
	/** 预留位：当前官方 API 不支持 3D HTML 导出，固定为 false */
	export3DHtml: boolean;
	/** 工程源文件：V3(.epro2) 与 V2(.epro) 可各自独立勾选，两者都勾就都导出 */
	exportProjectV3: boolean;
	exportProjectV2: boolean;
	/** 导出前运行 DRC */
	runDrc: boolean;
	/** 输出根目录（用户选择） */
	outputDir: string;
	/** 记住上次输出目录 */
	rememberOutputDir: boolean;
	/** 制造要求（写入双语提醒文件、Gerber ZIP 与导出报告） */
	boardThicknessMm: string;
	solderMaskColor: string;
	silkscreenColor: string;
	surfaceFinish: string;
	impedanceControl: boolean;
	manufacturingNotes: string;
}

export interface ManufacturingRequirements {
	boardThicknessMm: string;
	solderMaskColor: string;
	silkscreenColor: string;
	surfaceFinish: string;
	impedanceControl: boolean;
	customNotes: string;
}

/** 单个导出步骤的执行结果 */
export type StepStatus = 'OK' | 'FAILED' | 'SKIPPED' | 'NOT SUPPORTED';

export interface StepResult {
	step: string;
	status: StepStatus;
	/** 实际写出的文件名（成功时） */
	fileName?: string;
	/** 失败原因 / 跳过原因（失败或跳过时） */
	detail?: string;
}

/** CPL 过滤的统计结果 */
export interface CplFilterResult {
	/** 是否真的执行了过滤 */
	executed: boolean;
	/** 未能执行时的原因 */
	reason?: string;
	originalCount: number;
	finalCount: number;
	removedCount: number;
	removedDesignators: string[];
}

/** BOM → CPL 反向检查结果（仅告警，不阻断） */
export interface BomCplCrossCheckResult {
	/** 在 BOM 中但不在 CPL 中的位号 */
	missingInCpl: string[];
}

/** DRC 检查结果 */
export interface DrcResult {
	/** 是否执行了 DRC */
	executed: boolean;
	/** 通过与否 */
	passed: boolean;
	/** 详细条目总数（官方返回 Array<any>，结构未公开） */
	itemCount: number;
	/** 尽最大努力归类出的错误 / 警告数量，无法归类时为 undefined */
	errorCount?: number;
	/** 尽最大努力归类出的未布线数量，无法归类时为 undefined */
	unroutedCount?: number;
	/** 原始返回（截断后写入报告，便于人工核对） */
	rawSummary?: string;
	/** 执行失败时的原因 */
	error?: string;
}

/** 一次完整导出的上下文与结果 */
export interface ExportRunResult {
	boardName: string;
	exportDate: string;
	edaVersion: string;
	pluginVersion: string;
	outputDir: string;
	steps: StepResult[];
	cplFilter: CplFilterResult;
	crossCheck: BomCplCrossCheckResult;
	drc: DrcResult;
	/** 全流程级别的致命错误（例如权限不足、无法创建目录） */
	fatalError?: string;
	/**
	 * 运行时环境说明：当前 EasyEDA 版本、客户端类型、缺失的官方接口、
	 * 目录版本号采用了哪一级降级策略等。
	 *
	 * 之所以要写进报告，是因为「同一个插件在不同 EDA 版本上表现不同」
	 * 这件事必须留痕 —— 事后翻这份报告就能知道当时环境缺什么、
	 * 插件当时走的是哪条降级路径。
	 */
	environmentNotes: string[];
	warnings: string[];
	/**
	 * **必须让用户第一时间看到**的环境降级说明。
	 *
	 * 与 `warnings` 的区别：warnings 只统计数量、详情留在报告里；
	 * 而这里的条目会**原样显示在完成窗口顶部**。
	 *
	 * 专门用于「结果可能不符合用户预期」的情形，例如：
	 *   · 输出目录被改写到了别处（用户按原路径去找会找不到文件）；
	 *   · 日期子目录建不出来，退化为平铺输出。
	 * 这类信息若只写进报告，用户看到的是一个「成功」提示，
	 * 却怎么也找不到文件 —— 那是最糟糕的结果。
	 */
	criticalNotes: string[];
	manufacturingRequirements: ManufacturingRequirements;
}

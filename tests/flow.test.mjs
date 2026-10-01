/**
 * flow.test.mjs —— 端到端流程验证（在 Node 中模拟 EasyEDA 运行时）
 *
 * 验证目标（对应用户反馈与需求）：
 *   1. 点菜单后**确实会弹出配置窗口**（showSelectDialog 被调用）
 *   2. 窗口里的必选项说明、可选项列表、默认勾选状态正确
 *   3. 勾选「更换输出目录」后会调起目录选择（并按本机能力降级）
 *   4. 输出目录按 `板名_YYYYMMDD` 创建（本地日期，非 UTC）
 *   5. 每个勾选项都写出了对应文件，未勾选的不写
 *   6. 完成后弹出结果窗口，内容包含目录与文件清单
 *   7. 全程不向调用方抛出异常
 *   8. **接口挂起时不得让插件卡死**（「点击无反应」的回归测试）
 *   9. **旧版客户端缺接口时按能力降级**（模拟 EasyEDA 3.2.149）
 *
 * 说明：这里把打包产物 `dist/index.js` 放进 `node:vm` 里、注入 mock `eda` 后
 * **真实执行**，因此能验证「点击菜单之后到底发生了什么」，而不是只跑纯函数。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// 默认指向本仓库的打包产物（需先执行 npm run build）；也可用命令行参数覆盖
const DIST = process.argv[2] || fileURLToPath(new URL('../dist/index.js', import.meta.url));
const code = readFileSync(DIST, 'utf8');

let passed = 0;
const failures = [];
function check(name, cond, extra) {
	if (cond) {
		passed++;
		console.log(`  PASS  ${name}`);
	}
	else {
		failures.push(name);
		console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
	}
}
function eq(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	check(name, a === e, `expected ${e}, got ${a}`);
}
function has(name, actual, needle) {
	check(name, typeof actual === 'string' && actual.includes(needle),
		`未包含 ${JSON.stringify(needle)}；实际前 160 字: ${String(actual).slice(0, 160)}`);
}
function notHas(name, actual, needle) {
	check(name, typeof actual === 'string' && !actual.includes(needle),
		`不应包含 ${JSON.stringify(needle)}；实际前 160 字: ${String(actual).slice(0, 160)}`);
}

/** 本地日期 YYYYMMDD（与插件同算法，刻意不用 UTC） */
function localYmd(d = new Date()) {
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function fakeFile(name) {
	return {
		name,
		size: 2048,
		type: 'application/octet-stream',
		text: () => Promise.resolve('<!doctype html><html><body><div>位号</div></body></html>'),
	};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * mock eda
 *
 * `missing` 用于**模拟旧版客户端**：这些路径被显式置为 undefined，
 * 与真机上「属性根本不存在」的行为一致（`typeof` 不是 function，调用即 TypeError）。
 * ------------------------------------------------------------------ */

function makeEda({ handlers = {}, calls = [], missing = [] }) {
	const missingSet = new Set(missing);

	const fn = (path) => {
		const proxy = new Proxy(function () {}, {
			apply(_t, _this, args) {
				calls.push({ path, args });
				const h = handlers[path];
				if (h)
					return h(args);
				return undefined;
			},
			get(_t, prop) {
				if (typeof prop === 'symbol' || prop === 'then')
					return undefined;
				const next = `${path}.${String(prop)}`;
				if (missingSet.has(next))
					return undefined;
				return fn(next);
			},
		});
		return proxy;
	};

	const cache = new Map();
	const ns = (name) => {
		if (cache.has(name))
			return cache.get(name);
		const o = new Proxy(function () {}, {
			get(_t, prop) {
				if (typeof prop === 'symbol' || prop === 'then')
					return undefined;
				const next = `${name}.${String(prop)}`;
				if (missingSet.has(next))
					return undefined;
				return fn(next);
			},
		});
		cache.set(name, o);
		return o;
	};

	return new Proxy({}, {
		get(_t, prop) {
			if (typeof prop === 'symbol')
				return undefined;
			if (missingSet.has(String(prop)))
				return undefined;
			return ns(String(prop));
		},
	});
}

/** 从 mock Blob 里取回文本（报告文件用它做内容断言） */
function blobText(blob) {
	if (!blob || !Array.isArray(blob.parts))
		return '';
	return blob.parts.map(p => (typeof p === 'string' ? p : '')).join('');
}

/**
 * 造一个独立沙箱并加载打包产物。
 *
 * @param setTimeoutImpl 默认让 setTimeout 永不回调，用来证明「流程不依赖超时兜底也能走完」；
 *                       测挂起场景时传入被压缩过的真实计时器。
 */
function loadSandbox({ eda, setTimeoutImpl, alertImpl }) {
	const sb = {
		eda,
		console: { log: () => {}, error: () => {}, warn: () => {} },
		alert: alertImpl ?? (() => {}),
		setTimeout: setTimeoutImpl ?? (() => 1),
		clearTimeout: () => {},
		Blob: class Blob {
			constructor(parts) { this.parts = parts; }
		},
		File: class File {},
		DOMParser: class DOMParser {},
		Uint8Array,
		ArrayBuffer,
	};
	sb.globalThis = sb;
	sb.window = sb;
	sb.self = sb;
	const ctx = vm.createContext(sb);
	vm.runInContext(code, ctx, { filename: 'dist/index.js' });
	return ctx;
}

const tick = () => new Promise(r => setImmediate(r));

/** 通用：环境 / 存储 / 工程 / 制造文件 的 handler（各场景共用） */
function baseHandlers(overrides = {}) {
	return {
		'sys_Environment.isClient': () => true,
		'sys_Environment.getEditorCurrentVersion': () => '3.2.15-test',
		'sys_I18n.text': args => args[0],
		'sys_Storage.getExtensionUserConfig': () => undefined,
		'sys_Storage.setExtensionUserConfig': () => Promise.resolve(true),
		'dmt_SelectControl.getCurrentDocumentInfo': () => Promise.resolve({ documentType: 3, uuid: 'pcb-demo', tabId: 'tab-pcb' }),
		'dmt_Board.getCurrentBoardInfo': () => Promise.resolve({ name: 'Demo Board' }),
		'dmt_Pcb.getPcbInfo': () => Promise.resolve({ name: 'PCB Document', parentBoardName: 'Demo Board' }),
		'dmt_Project.getCurrentProjectInfo': () => Promise.resolve({ friendlyName: 'Demo Project', name: 'demo-project' }),
		'pcb_Drc.check': () => Promise.resolve([]),
		'pcb_ManufactureData.getGerberFile': () => Promise.resolve(fakeFile('Demo_Board_Gerber.zip')),
		'pcb_ManufactureData.getBomFile': () => Promise.resolve(fakeFile('Demo_Board_BOM.xlsx')),
		'pcb_ManufactureData.getPickAndPlaceFile': () => Promise.resolve(fakeFile('Demo_Board_CPL.xlsx')),
		'pcb_ManufactureData.get3DFile': () => Promise.resolve(fakeFile('Demo_Board.step')),
		'pcb_ManufactureData.getInteractiveBomFile': () => Promise.resolve(fakeFile('Demo_Board_iBOM.html')),
		'sch_ManufactureData.getExportDocumentFile': () => Promise.resolve(fakeFile('Demo_Board_Schematic.pdf')),
		'sys_FileManager.getProjectFile': args => Promise.resolve(fakeFile(`Demo Board.${args[2]}`)),
		...overrides,
	};
}

/* ================================================================== *
 * 场景 1：能力齐全的客户端（新版本）
 * ================================================================== */

console.log('='.repeat(64));
console.log('端到端流程验证：点击菜单 → 配置窗口 → 导出');
console.log('='.repeat(64));

const calls = [];
const selectDialogs = [];
const infoDialogs = [];
const written = [];
const createdDirs = [];
const reportWrites = [];
let selectCallback = null;

const handlers = baseHandlers({
	'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
	'sys_FileSystem.existsPathInFileSystem': () => Promise.resolve(false),
	'sys_FileSystem.createDirectoryInFileSystem': (args) => {
		createdDirs.push(args[0]);
		return Promise.resolve(true);
	},
	'sys_FileSystem.saveFileToFileSystem': (args) => {
		written.push({ path: args[0], force: args[3], data: args[1] });
		if (String(args[0]).endsWith('Export_Report.txt'))
			reportWrites.push(blobText(args[1]));
		return Promise.resolve(true);
	},
	'sys_FileSystem.openReadFolderPathDialog': () => Promise.resolve('D:/PCB_Out'),
	'sys_Dialog.showSelectDialog': (args) => {
		selectDialogs.push(args);
		selectCallback = args[6];
		return undefined;
	},
	'sys_Dialog.showInformationMessage': (args) => {
		infoDialogs.push(args);
		return undefined;
	},
});

const ctxMain = loadSandbox({ eda: makeEda({ handlers, calls }) });
const ns = ctxMain.edaEsbuildExportName;

/* ---------- 1. 点菜单 ---------- */
console.log('\n[1] 点击「一键导出」菜单项');
let threw = null;
try {
	ns.exportDeliveryPackage();
}
catch (error) {
	threw = error;
}
await tick();
await tick();
await tick();

check('exportDeliveryPackage 未抛异常', threw === null,
	threw ? `${threw.name}: ${threw.message}` : '');
eq('弹出了 1 个配置窗口', selectDialogs.length, 1);

/* ---------- 2. 校验配置窗口内容 ---------- */
console.log('\n[2] 校验配置窗口内容');
const [options, before, after, title, defaultOption, multiple, cb] = selectDialogs[0] ?? [];

check('showSelectDialog 参数齐全', Array.isArray(options) && typeof before === 'string'
	&& typeof after === 'string' && typeof title === 'string' && Array.isArray(defaultOption)
	&& multiple === true && typeof cb === 'function', '');

const values = (options ?? []).map(o => o.value);
eq('可选项键集合', values,
	['cplFilter', 'schematicPdf', 'step', 'interactiveBom', 'projectV3', 'projectV2', 'runDrc', 'changeOutputDir']);

has('说明里点明 Gerber 为必选', before, 'Gerber');
has('说明里点明 BOM 为必选', before, 'BOM');
has('说明里点明 CPL 为必选', before, 'CPL');
has('说明里声明「始终导出」', before, '始终导出');
has('窗口标题正确', title, '导出设置');

// 用户明确要求「是否过滤坐标文件是可选项，默认选中」⇒ cplFilter 必须在默认勾选里
eq('默认勾选（首次使用）', defaultOption,
	['cplFilter']);

has('提示 3D HTML 官方不支持', after, 'does not support');

/* ---------- 3. 用户勾选并确认 ---------- */
console.log('\n[3] 用户勾选：PDF + STEP + iBOM + 工程V3 + 更换输出目录');
let cbThrew = null;
try {
	cb(['schematicPdf', 'step', 'interactiveBom', 'projectV3', 'changeOutputDir']);
}
catch (error) {
	cbThrew = error;
}
check('配置回调未抛异常', cbThrew === null, cbThrew ? `${cbThrew.name}: ${cbThrew.message}` : '');

for (let i = 0; i < 14; i++)
	await tick();

check('调起了原生目录选择框',
	calls.some(c => c.path === 'sys_FileSystem.openReadFolderPathDialog'), '');

/* ---------- 4. 输出目录 ---------- */
console.log('\n[4] 输出目录与日期版本目录');
// 注意：板名 "Demo Board" 中的空格是合法的 Windows 目录名字符，**不应**被替换。
// sanitizeName 只替换 \ / : * ? " < > | 与控制字符，并 trim 首尾空格。
const expectedDir = `D:/PCB_Out/Demo Board_${localYmd()}`;
// 预检阶段会顺带确保「所选根目录」存在，因此 createdDirs 可能多出根目录一项；
// 这里断言的核心是：日期版本子目录必须被创建，且不带 _02 后缀（首次导出）。
check('创建了日期版本目录', createdDirs.includes(expectedDir),
	`实际=${JSON.stringify(createdDirs)}`);
check('首次导出不带 _02 后缀',
	createdDirs.every(d => !/_0\d$/.test(String(d))),
	`实际=${JSON.stringify(createdDirs)}`);
check('日期使用本地日期（非 UTC）',
	expectedDir.endsWith(localYmd()), `期望后缀 ${localYmd()}`);
check('板名中的空格被保留（合法字符）',
	expectedDir.includes('Demo Board_'), expectedDir);
check('命名使用当前板名，而不是项目名',
	calls.some(c => c.path === 'dmt_Board.getCurrentBoardInfo')
	&& !expectedDir.includes('Demo Project'), expectedDir);

/* ---------- 5. 写出的文件 ---------- */
console.log('\n[5] 写出的交付文件');
const names = written.map(w => w.path.split(/[/\\]/).pop());
console.log('     ', JSON.stringify(names));

check('Gerber 已写出', names.includes('Demo Board_Gerber.zip'), '');
check('BOM 已写出', names.includes('Demo Board_BOM.xlsx'), '');
check('CPL 已写出', names.includes('Demo Board_CPL.xlsx'), '');
check('原理图 PDF 已写出', names.includes('Demo Board_Schematic.pdf'), '');
check('STEP 已写出', names.includes('Demo Board.step'), '');
check('交互式 BOM 已写出', names.includes('Demo Board_iBOM.html'), '');
check('工程 V3 已写出', names.includes('Demo Board.epro2'), '');
check('导出报告已写出', names.includes('Export_Report.txt'), '');
check('未勾选 V2 → 不写 .epro', !names.includes('Demo Board.epro'), JSON.stringify(names));

console.log('\n[5b] 报告内容与环境留痕');
const finalReport = reportWrites.at(-1) ?? '';
has('报告含 Gerber 状态行', finalReport, 'Gerber: OK');
has('报告记录当前板名', finalReport, 'Board:\nDemo Board');
has('报告含 ENVIRONMENT 段', finalReport, 'ENVIRONMENT');
has('报告记录了目录判定策略为 exist-check', finalReport, 'exist-check');
has('报告记录了输出目录来源', finalReport, '输出目录来源');
notHas('完整可用环境下不应出现缺失接口告警', finalReport, '官方接口缺失: 共');

/* ---------- 6. 完成窗口 ---------- */
console.log('\n[6] 完成窗口内容');
eq('弹出了完成窗口', infoDialogs.length, 1);
const completion = infoDialogs[0]?.[0] ?? '';
has('完成窗口显示输出目录', completion, expectedDir);
has('完成窗口显示 Gerber 成功', completion, 'Gerber');
has('完成窗口显示 iBOM 成功', completion, '交互式 BOM');
has('完成窗口显示 3D HTML 不支持', completion, '不支持');
has('完成窗口显示 CPL 结果', completion, 'CPL');

/* ---------- 7. 未打开 PCB 时的分支 ---------- */
console.log('\n[7] 未打开 PCB 文档时的分支');
{
	const calls2 = [];
	const info2 = [];
	const ctx2 = loadSandbox({
		eda: makeEda({
			calls: calls2,
			handlers: baseHandlers({
				'dmt_SelectControl.getCurrentDocumentInfo': () => Promise.resolve({ documentType: 1 }),
				'sys_Storage.getExtensionUserConfig': args => args[0] === 'delivery-settings'
					? JSON.stringify({ outputDir: 'D:/PCB_Out', cplFilterEnabled: true })
					: undefined,
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_Dialog.showInformationMessage': (args) => { info2.push(args); return undefined; },
			}),
		}),
	});

	let t2 = null;
	try {
		ctx2.edaEsbuildExportName.exportDeliveryPackage();
	}
	catch (error) {
		t2 = error;
	}
	for (let i = 0; i < 6; i++)
		await tick();
	const selectCall2 = calls2.find(c => c.path === 'sys_Dialog.showSelectDialog');
	selectCall2?.args?.[6]?.(['cplFilter']);
	for (let i = 0; i < 12; i++)
		await tick();

	check('未打开 PCB 时不抛异常', t2 === null, t2 ? `${t2.name}: ${t2.message}` : '');
	eq('未打开 PCB 时弹出提示', info2.length, 1);
	has('提示内容正确', info2[0]?.[0], '请先打开 PCB 文档');
	check('未打开 PCB 时不做任何导出',
		!calls2.some(c => c.path.startsWith('pcb_ManufactureData.')), '');
}

/* ---------- 8. 关键回归：官方弹窗全缺失时仍有可见反馈 ---------- */
console.log('\n[8] 回归：官方弹窗 API 全部缺失时不得静默');
{
	const stillVisible = [];
	const eda3 = makeEda({
		calls: [],
		handlers: {
			'sys_Environment.isClient': () => true,
			'dmt_SelectControl.getCurrentDocumentInfo': () => Promise.resolve({ documentType: 3 }),
			'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
		},
		// 三个官方通知通道整体移除
		missing: ['sys_Dialog', 'sys_MessageBox', 'sys_Message'],
	});

	const ctx3 = loadSandbox({ eda: eda3, alertImpl: msg => stillVisible.push(msg) });

	let t3 = null;
	try {
		ctx3.edaEsbuildExportName.exportDeliveryPackage();
	}
	catch (error) {
		t3 = error;
	}
	for (let i = 0; i < 6; i++)
		await tick();

	check('弹窗 API 缺失时也不抛异常', t3 === null, t3 ? `${t3.name}: ${t3.message}` : '');
	check('弹窗 API 缺失时依然有可见反馈（alert 兜底）', stillVisible.length > 0,
		`alert 次数=${stillVisible.length}`);
}

/* ================================================================== *
 * 场景 2：旧版客户端（模拟 EasyEDA Pro 3.2.149，缺目录管理接口）
 *
 * 这正是收到「点了没反应 / 核心 API 缺失」反馈的那台机器：
 *   · createDirectoryInFileSystem  —— EDA v3.2.166 才引入
 *   · existsPathInFileSystem       —— EDA v3.2.167 才引入
 *   · openReadFolderPathDialog     —— 旧版没有
 * 期望：插件不报错、不卡死，自动降级到「写入探测 + 手动填路径」，
 *       并把降级事实如实写进报告。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 2：EasyEDA Pro 3.2.149 兼容降级');
console.log('='.repeat(64));

const MISSING_3149 = [
	'sys_FileSystem.createDirectoryInFileSystem',
	'sys_FileSystem.existsPathInFileSystem',
	'sys_FileSystem.openReadFolderPathDialog',
	'sys_FileSystem.openReadFilePathDialog',
	'sys_FileSystem.listFilesOfFileSystem',
];

{
	const calls9 = [];
	const select9 = [];
	const info9 = [];
	const written9 = [];
	const reports9 = [];
	let typedInput = null;

	const ctx9 = loadSandbox({
		eda: makeEda({
			calls: calls9,
			missing: MISSING_3149,
			handlers: baseHandlers({
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_FileSystem.saveFileToFileSystem': (args) => {
					written9.push({ path: args[0], force: args[3] });
					if (String(args[0]).endsWith('Export_Report.txt'))
						reports9.push(blobText(args[1]));
					return Promise.resolve(true);
				},
				'sys_Dialog.showSelectDialog': (args) => { select9.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': (args) => { info9.push(args); return undefined; },
				// 级别 3 的输入框：模拟用户手动填了一个路径
				'sys_Dialog.showInputDialog': (args) => {
					typedInput = args[4];
					args[6]('D:/OldBoard_Out');
					return undefined;
				},
			}),
		}),
	});

	console.log('\n[9] 旧版客户端：缺 5 个接口时仍可用');
	let t9 = null;
	try {
		ctx9.edaEsbuildExportName.exportDeliveryPackage();
	}
	catch (error) {
		t9 = error;
	}
	for (let i = 0; i < 8; i++)
		await tick();

	check('缺接口时不抛异常', t9 === null, t9 ? `${t9.name}: ${t9.message}` : '');
	eq('缺接口时仍然弹出配置窗口', select9.length, 1);

	// 走到配置流程后，用户勾选「更换输出目录」
	const cb9 = select9[0]?.[6];
	cb9?.(['schematicPdf', 'changeOutputDir']);
	for (let i = 0; i < 16; i++)
		await tick();

	check('降级到输入框（原生目录选择框不可用）',
		calls9.some(c => c.path === 'sys_Dialog.showInputDialog'), '');
	check('不再调用不存在的 createDirectoryInFileSystem',
		!calls9.some(c => c.path === 'sys_FileSystem.createDirectoryInFileSystem'), '');
	check('输入框预填了兜底默认值（EDA 文档目录 / PCB_Delivery）',
		typeof typedInput === 'string' && typedInput.includes('PCB_Delivery'), `实际=${typedInput}`);

	const expectedRoot9 = 'D:/OldBoard_Out';
	const expectedPrefix9 = `Demo Board_${localYmd()}`;
	const probeWrite = written9[0];
	check('首个写入直接探测所选目录（不触碰不存在的子目录）',
		typeof probeWrite?.path === 'string'
		&& probeWrite.path === `${expectedRoot9}/${expectedPrefix9}_Export_Report.txt`,
		`实际=${probeWrite?.path}`);
	check('探测写入使用 force=false（据此判断目录是否被历史交付占用）',
		probeWrite?.force === false, `实际 force=${probeWrite?.force}`);
	check('最终报告使用 force=true 覆盖占位文件',
		written9.at(-1)?.force === true, `实际 force=${written9.at(-1)?.force}`);

	const report9 = reports9.at(-1) ?? '';
	has('报告记录了降级策略 write-probe', report9, 'write-probe');
	has('报告说明缺建目录接口时直接平铺', report9, '直接采用平铺输出');
	has('报告列出缺失接口', report9, '官方接口缺失: 共');
	has('报告给出升级建议', report9, '版本建议');

	eq('完成窗口仍然弹出', info9.length, 1);
	has('完成窗口显示实际输出目录', info9[0]?.[0], expectedRoot9);
}

/* ================================================================== *
 * 场景 2b：用户真机的实际配置 —— 无原生选择框，**但列目录接口可用**
 *
 * 用户反馈原文：「存储路径应该是浏览的，不是添的」。
 * 本机 `openReadFolderPathDialog` / `openReadFilePathDialog` 都 MISS，
 * 但 `listFilesOfFileSystem` 可用 ⇒ 必须走「逐级浏览文件夹」，
 * 而不是退回手填输入框。同时验证 CPL 过滤已变成默认勾选的可选项。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 2b：逐级浏览文件夹（列目录接口可用，无原生选择框）');
console.log('='.repeat(64));

const MISSING_NO_PICKER = [
	'sys_FileSystem.createDirectoryInFileSystem',
	'sys_FileSystem.existsPathInFileSystem',
	'sys_FileSystem.openReadFolderPathDialog',
	'sys_FileSystem.openReadFilePathDialog',
];

{
	const callsB = [];
	const selectB = [];
	const infoB = [];
	const writtenB = [];
	const reportsB = [];

	const listTree = {
		'C:/EDA': [{ fileName: 'Projects', isDirectory: true, fullPath: 'C:/EDA/Projects' }],
		'C:/EDA/Projects': [{ fileName: 'Sub', isDirectory: true, fullPath: 'C:/EDA/Projects/Sub' }],
	};

	const ctxB = loadSandbox({
		eda: makeEda({
			calls: callsB,
			missing: MISSING_NO_PICKER,
			handlers: baseHandlers({
				'sys_FileSystem.getProjectsPaths': () => Promise.resolve(['C:/EDA/Projects']),
				'sys_FileSystem.getEdaPath': () => Promise.resolve('C:/EDA/EDA.exe'),
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_FileSystem.listFilesOfFileSystem': args =>
					Promise.resolve(listTree[String(args[0])] ?? []),
				'sys_FileSystem.saveFileToFileSystem': (args) => {
					writtenB.push({ path: args[0], force: args[3] });
					if (String(args[0]).endsWith('Export_Report.txt'))
						reportsB.push(blobText(args[1]));
					return Promise.resolve(true);
				},
				'sys_Dialog.showSelectDialog': (args) => { selectB.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': (args) => { infoB.push(args); return undefined; },
			}),
		}),
	});

	console.log('\n[2b] 逐级浏览：目录是「浏览」出来的，不是手填的');
	let errB = null;
	try {
		ctxB.edaEsbuildExportName.exportDeliveryPackage();
	}
	catch (error) {
		errB = error;
	}
	for (let i = 0; i < 8; i++)
		await tick();

	check('浏览模式下不抛异常', errB === null, errB ? `${errB.name}: ${errB.message}` : '');
	eq('仍然先弹出配置窗口', selectB.length, 1);

	// ---- 需求：CPL 过滤是可选项且默认勾选 ----
	const configOptions = selectB[0]?.[0] ?? [];
	const configDefaults = selectB[0]?.[4] ?? [];
	check('配置窗口含「CPL 按 BOM 过滤」可选项',
		configOptions.some(o => o?.value === 'cplFilter'),
		`实际=${configOptions.map(o => o?.value).join(',')}`);
	check('CPL 过滤默认勾选',
		Array.isArray(configDefaults) && configDefaults.includes('cplFilter'),
		`实际=${JSON.stringify(configDefaults)}`);

	// ---- 需求：选项压平，不再是一行塞满说明的长标签 ----
	const longLabels = configOptions.filter(o => String(o?.displayContent ?? '').length > 40);
	eq('没有超长选项标签（无需横向/纵向滚动）', longLabels.length, 0);
	const multiline = configOptions.filter(o => String(o?.displayContent ?? '').includes('\n'));
	eq('没有多行选项标签', multiline.length, 0);

	// ---- 用户勾选「更换输出目录」 ----
	selectB[0]?.[6]?.(['schematicPdf', 'changeOutputDir']);
	for (let i = 0; i < 16; i++)
		await tick();

	check('走了逐级浏览（调用了列目录接口）',
		callsB.some(c => c.path === 'sys_FileSystem.listFilesOfFileSystem'), '');
	check('没有退回手填输入框',
		!callsB.some(c => c.path === 'sys_Dialog.showInputDialog'), '');
	check('没有调用不存在的原生目录选择框',
		!callsB.some(c => c.path === 'sys_FileSystem.openReadFolderPathDialog'), '');

	eq('弹出了浏览窗口', selectB.length, 2);
	const browseOptions = selectB[1]?.[0] ?? [];
	check('浏览窗口第一项是「就用这个目录」',
		String(browseOptions[0]?.value ?? '') === '__use__',
		`实际=${browseOptions[0]?.value}`);
	check('浏览窗口列出了子文件夹',
		browseOptions.some(o => String(o?.value ?? '').startsWith('__dir__')), '');

	// ---- 进入子目录，再确认 ----
	const browseCb = selectB[1]?.[6];
	browseCb?.('__dir__C:/EDA/Projects');
	for (let i = 0; i < 16; i++)
		await tick();

	eq('进入子目录后刷新浏览窗口', selectB.length, 3);
	const browseCb2 = selectB[2]?.[6];
	browseCb2?.('__use__');
	for (let i = 0; i < 24; i++)
		await tick();

	const expectedRootB = 'C:/EDA/Projects';
	const expectedPrefixB = `Demo Board_${localYmd()}`;
	check('输出目录来自浏览结果（不是手填）',
		writtenB.some(w => String(w.path).startsWith(`${expectedRootB}/${expectedPrefixB}`)),
		`实际=${writtenB.map(w => w.path).join(' | ')}`);

	const probeB = writtenB[0];
	check('首个写入是平铺探测写入', typeof probeB?.path === 'string'
		&& probeB.path === `${expectedRootB}/${expectedPrefixB}_Export_Report.txt`, `实际=${probeB?.path}`);
	check('探测写入 force=false', probeB?.force === false, `实际=${probeB?.force}`);
	check('最终报告 force=true', writtenB.at(-1)?.force === true,
		`实际=${writtenB.at(-1)?.force}`);

	const reportB = reportsB.at(-1) ?? '';
	has('报告记录了目录来源为浏览', reportB, 'browse(');

	eq('完成窗口仍然弹出', infoB.length, 1);
	has('完成窗口显示实际输出目录', infoB[0]?.[0], expectedRootB);
}

/* ================================================================== *
 * 场景 3：关键回归 —— 接口「存在但永不返回」
 *
 * 这是第一版「点击菜单没有任何反应」的根因形态：
 * 旧实现在弹配置窗口之前先 await 官方查询接口，接口不返回就永远走不到弹窗，
 * 而 try/catch 抓不住挂起。修复方式是给每个前置查询加硬超时。
 * 这里把 getCurrentDocumentInfo 换成永不 settle 的 Promise，验证插件依然弹窗。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 3：回归：前置查询接口永不返回时，插件不得卡死');
console.log('='.repeat(64));

{
	const select10 = [];
	const calls10 = [];
	const ctx10 = loadSandbox({
		eda: makeEda({
			calls: calls10,
			handlers: baseHandlers({
				// 永不 settle：模拟「接口存在但挂起」
				'dmt_SelectControl.getCurrentDocumentInfo': () => new Promise(() => {}),
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_Dialog.showSelectDialog': (args) => { select10.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': () => undefined,
			}),
		}),
		// 把 5 秒的硬超时压缩到 30 毫秒，以便测试快速跑完
		setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 30)),
	});

	console.log('\n[10] getCurrentDocumentInfo 永不返回');
	const startedAt = Date.now();
	ctx10.edaEsbuildExportName.exportDeliveryPackage();

	await sleep(300);

	const elapsed = Date.now() - startedAt;
	check('挂起接口不会让菜单回调卡死：300ms 内已弹出配置窗口',
		select10.length === 1, `弹窗数=${select10.length}，耗时=${elapsed}ms`);
	check('整体耗时远小于接口的超时上限', elapsed < 1000, `耗时=${elapsed}ms`);
	select10[0]?.[6]?.(['cplFilter', 'changeOutputDir']);
	await sleep(100);
	check('挂起被发现并写入日志（调用确实发生过）',
		calls10.some(c => c.path === 'dmt_SelectControl.getCurrentDocumentInfo'), '');
}


/* ================================================================== *
 * 场景 4：回归 —— 「无法写入输出目录（已连续尝试 20 次）」
 *
 * 用户真机事故：EasyEDA 3.2.149，缺少 createDirectoryInFileSystem，
 * 且 saveFileToFileSystem **不会隐式创建父目录**。
 * 旧实现把「写不进去」一律当成「目录已被占用」，于是换 _02…_20 逐个试，
 * 20 次全败后只丢出一句「已连续尝试 20 次」，用户一无所获。
 *
 * 期望的新行为：
 *   · 先真实写一次，失败后再判定子目录是否真的没被创建；
 *   · 确认建不出来 ⇒ **立刻停止换槽位**，退化为「平铺输出」；
 *   · 文件直接写进所选目录，文件名带日期前缀 ⇒ 导出**照常完成**。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 4：回归 —— 子目录建不出来时平铺输出（不再「尝试 20 次」）');
console.log('='.repeat(64));

{
	const PARENT = 'E:/work/fiverr/260922_aguepe6';
	const ROOT = `${PARENT}/out`;
	// 已存在的目录集合：模拟「写入接口不会隐式创建父目录」
	const existingDirs = new Set([PARENT, ROOT]);

	const calls4 = [];
	const select4 = [];
	const info4 = [];
	const written4 = [];

	const dirNameOf = (full) => {
		const p = String(full).replace(/[\\/]+$/, '');
		return p.slice(p.lastIndexOf('/') + 1);
	};
	const parentOf = (full) => {
		const p = String(full).replace(/[\\/]+$/, '');
		const i = p.lastIndexOf('/');
		return i <= 0 ? '' : p.slice(0, i);
	};
	const hasNonAscii = (v) => [...String(v)].some(ch => ch.codePointAt(0) > 0x7F);

	const ctx4 = loadSandbox({
		eda: makeEda({
			calls: calls4,
			missing: [
				'sys_FileSystem.createDirectoryInFileSystem',
				'sys_FileSystem.existsPathInFileSystem',
				'sys_FileSystem.openReadFolderPathDialog',
				'sys_FileSystem.openReadFilePathDialog',
			],
			handlers: baseHandlers({
				'sys_Storage.getExtensionUserConfig': () => ({ outputDir: ROOT }),
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_FileSystem.listFilesOfFileSystem': args =>
					Promise.resolve(String(args[0]) === PARENT
						? [{ fileName: 'out', isDirectory: true, fullPath: ROOT }]
						: []),
				// 关键：父目录不存在 ⇒ 写入失败（返回 false），不抛异常
				'sys_FileSystem.saveFileToFileSystem': (args) => {
					const uri = String(args[0]);
					const folderForm = /[\\/]$/.test(uri) && typeof args[2] === 'string';
					const full = folderForm ? `${uri}${args[2]}` : uri;
					const parent = parentOf(full);
					// 模拟该旧客户端：目录 URI 形式也不能隐式创建父目录。
					const ok = !folderForm && existingDirs.has(parent) && !hasNonAscii(parent);
					written4.push({ path: full, force: args[3], ok });
					return Promise.resolve(ok);
				},
				'sys_Dialog.showSelectDialog': (args) => { select4.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': (args) => { info4.push(args); return undefined; },
			}),
		}),
	});

	console.log('\n[4a] 所选目录为「输出」，子目录建不出来');
	let err4 = null;
	try {
		ctx4.edaEsbuildExportName.exportDeliveryPackage();
	}
	catch (error) {
		err4 = error;
	}
	for (let i = 0; i < 8; i++)
		await tick();

	check('平铺降级路径不抛异常', err4 === null, err4 ? `${err4.name}: ${err4.message}` : '');
	eq('仍然弹出配置窗口', select4.length, 1);
	// 输出目录已预置在设置里，直接确认即可（不再走目录选择环节）
	select4[0]?.[6]?.(['schematicPdf', 'step', 'interactiveBom', 'projectV3']);
	for (let i = 0; i < 30; i++)
		await tick();

	// ---- 核心断言：不再出现「换 20 个槽位」 ----
	// 只统计「往日期子目录里做的探测写入」：写进子目录的 Export_Report.txt
	const subDirProbes = written4.filter(w => {
		const p = String(w.path);
		return p.endsWith('Export_Report.txt') && p.slice(`${ROOT}/`.length).includes('/');
	});
	check('缺少建目录接口时完全不探测不存在的日期子目录',
		subDirProbes.length === 0,
		`实际=${subDirProbes.map(w => w.path).join(' | ')}`);

	const flatPrefix = `Demo Board_${localYmd()}`;
	const flatFiles = written4.filter(w => String(w.path).startsWith(`${ROOT}/`));
	check('文件直接平铺输出到所选目录',
		flatFiles.some(w => String(w.path) === `${ROOT}/${flatPrefix}_Gerber.zip`),
		`实际=${flatFiles.map(w => w.path).join(' | ')}`);
	const flatNamed = flatFiles.filter(w => !String(w.path).endsWith('Export_Report.txt'));
	check('平铺输出文件名带日期前缀以区分不同日期',
		flatNamed.length > 0
		&& flatNamed.every(w => String(w.path).slice(`${ROOT}/`.length).startsWith(flatPrefix)),
		`实际=${flatNamed.map(w => w.path).join(' | ')}`);
	check('平铺导出首次不带 _02 后缀',
		flatNamed.every(w => !/_\d{8}_0\d_/.test(String(w.path))),
		`实际=${flatNamed.map(w => w.path).join(' | ')}`);
	check('导出真的完成（Gerber / BOM / CPL / PDF 都在）',
		['_Gerber.zip', '_BOM.xlsx', '_CPL.xlsx', '_Schematic.pdf']
			.every(suf => flatFiles.some(w => String(w.path).endsWith(suf))),
		`实际=${flatFiles.map(w => w.path).join(' | ')}`);

	eq('完成窗口仍然弹出', info4.length, 1);
	const completion4 = info4[0]?.[0] ?? '';
	has('完成窗口显示的是真正用到的目录', completion4, ROOT);
	has('完成窗口如实说明平铺降级', completion4, '平铺');
}

/* ================================================================== *
 * 场景 5：回归 —— 所选目录整体不可写（非 ASCII 路径）时改写到救援目录
 *
 * 用户的失败路径 `E:/.../POE传感器/输出` 含中文。若个别旧版客户端在
 * 非 ASCII 路径上写入直接失败，则换任何日期子目录都无用。
 * 期望：自动改写到官方提供的（通常纯 ASCII）目录，并在报告里如实说明，
 * 而不是让用户一无所获。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 5：回归 —— 所选目录不可写时自动改用救援目录');
console.log('='.repeat(64));

{
	const BAD_ROOT = 'E:/work/fiverr/260922_aguepe6_POE传感器/输出';
	const DOCUMENTS = 'C:/Users/qixia/Documents';

	const calls5 = [];
	const select5 = [];
	const info5 = [];
	const written5 = [];

	const hasNonAscii = (v) => [...String(v)].some(ch => ch.codePointAt(0) > 0x7F);
	const parentOf = (full) => {
		const p = String(full).replace(/[\\/]+$/, '');
		const i = p.lastIndexOf('/');
		return i <= 0 ? '' : p.slice(0, i);
	};

	const ctx5 = loadSandbox({
		eda: makeEda({
			calls: calls5,
			missing: [
				'sys_FileSystem.createDirectoryInFileSystem',
				'sys_FileSystem.existsPathInFileSystem',
				'sys_FileSystem.openReadFolderPathDialog',
				'sys_FileSystem.openReadFilePathDialog',
				'sys_FileSystem.listFilesOfFileSystem',
			],
			handlers: baseHandlers({
				'sys_Storage.getExtensionUserConfig': () => ({ outputDir: BAD_ROOT }),
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve(DOCUMENTS),
				// 关键：凡含非 ASCII 的路径一律写不进去
				'sys_FileSystem.saveFileToFileSystem': (args) => {
					const full = String(args[0]);
					const ok = !hasNonAscii(parentOf(full));
					written5.push({ path: full, force: args[3], ok });
					return Promise.resolve(ok);
				},
				'sys_Dialog.showInputDialog': () => Promise.resolve(BAD_ROOT),
				'sys_Dialog.showSelectDialog': (args) => { select5.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': (args) => { info5.push(args); return undefined; },
			}),
		}),
	});

	console.log('\n[5a] 用户选了含中文的目录，且该路径写不进去');
	let err5 = null;
	try {
		ctx5.edaEsbuildExportName.exportDeliveryPackage();
	}
	catch (error) {
		err5 = error;
	}
	for (let i = 0; i < 8; i++)
		await tick();

	check('救援路径不抛异常', err5 === null, err5 ? `${err5.name}: ${err5.message}` : '');
	select5[0]?.[6]?.(['schematicPdf']);
	for (let i = 0; i < 40; i++)
		await tick();

	const rescueFiles = written5.filter(w => String(w.path).startsWith(`${DOCUMENTS}/`));
	check('文件已改写到救援目录（用户仍能拿到文件）',
		rescueFiles.some(w => String(w.path).endsWith('_Gerber.zip')),
		`实际=${written5.map(w => w.path).join(' | ')}`);
	const rescueNamed = rescueFiles.filter(w => !String(w.path).endsWith('Export_Report.txt'));
	check('文件名带日期前缀',
		rescueNamed.length > 0
		&& rescueNamed.every(w => String(w.path).includes(`Demo Board_${localYmd()}`)),
		`实际=${rescueNamed.map(w => w.path).join(' | ')}`);

	eq('完成窗口仍然弹出', info5.length, 1);
	const completion5 = info5[0]?.[0] ?? '';
	has('完成窗口显示的是救援目录（不是那个写不进去的目录）', completion5, DOCUMENTS);
	has('完成窗口如实说明「输出目录已改写」', completion5, '改写');
}

/* ================================================================== *
 * 场景 6：回归 —— Toast 时长的单位是「秒」而不是毫秒
 *
 * 用户反馈「这几个信息条一直不消失」。官方签名的第三个参数 timer 单位是秒，
 * 旧代码按毫秒传了 8000 / 6000 / 3000 ⇒ Toast 挂 2 小时才消失。
 * 本场景让所有弹窗通道失效、只留 Toast，断言传给官方的时长在合理区间。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 6：回归 —— Toast 自动关闭时长单位为「秒」');
console.log('='.repeat(64));

{
	const calls6 = [];
	const select6 = [];
	const toasts6 = [];

	const ctx6 = loadSandbox({
		eda: makeEda({
			calls: calls6,
			missing: ['sys_Dialog', 'sys_MessageBox'],
			handlers: baseHandlers({
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_FileSystem.existsPathInFileSystem': () => Promise.resolve(false),
				'sys_FileSystem.createDirectoryInFileSystem': () => Promise.resolve(true),
				'sys_FileSystem.saveFileToFileSystem': () => Promise.resolve(true),
				'sys_FileSystem.openReadFolderPathDialog': () => Promise.resolve('D:/PCB_Out'),
				'sys_Message.showToastMessage': (args) => { toasts6.push(args); return undefined; },
				'sys_Dialog.showSelectDialog': (args) => { select6.push(args); return undefined; },
			}),
		}),
	});

	console.log('\n[6a] 只有 Toast 可用时，时长必须落在「秒」的合理区间');
	ctx6.edaEsbuildExportName.exportDeliveryPackage();
	for (let i = 0; i < 8; i++)
		await tick();
	select6[0]?.[6]?.(['schematicPdf']);
	for (let i = 0; i < 30; i++)
		await tick();

	check('确实走了 Toast 通道', toasts6.length > 0, `toast 数=${toasts6.length}`);

	const timers = toasts6.map(a => a[2]).filter(v => typeof v === 'number');
	check('每个 Toast 都显式给了时长', timers.length === toasts6.length,
		`实际=${JSON.stringify(toasts6.map(a => a[2]))}`);
	check('时长不超过 60 秒（即没有把「秒」当成毫秒传）',
		timers.every(v => v > 0 && v <= 60), `实际=${JSON.stringify(timers)}`);
	check('时长至少 1 秒（不能是毫秒级的残值）',
		timers.every(v => v >= 1), `实际=${JSON.stringify(timers)}`);
}


/* ================================================================== *
 * 场景 7：配置窗口走 sys_IFrame 自定义窗口（平铺复选框 + 浏览按钮）
 *
 * 用户反馈：官方 showSelectDialog(multiple) 在 3.2.149 上渲染为**可折叠下拉**，
 * 「选项被折叠/要滚动」，且要求「选项平铺到界面上」「路径添加一个浏览按钮」。
 * v1.4.0 起优先打开 /iframe/config.html（平铺复选框 + 浏览按钮），
 * 与主脚本经 sys_Storage 桥通信（官方推荐的跨上下文方式）。
 *
 * 本场景模拟 iframe 页面的完整行为：读请求 → 写心跳 → 写结果。
 * 期望：完全不走 showSelectDialog；设置以 JSON 字符串持久化并被读回。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 7：配置窗口优先走 sys_IFrame 自定义窗口（不再下拉菜单）');
console.log('='.repeat(64));

{
	const ROOT7 = 'D:/PCB_Out';
	const storage7 = new Map();
	const iframeCalls7 = [];
	const select7 = [];
	const info7 = [];
	const written7 = [];
	const calls7 = [];

	const ctx7 = loadSandbox({
		eda: makeEda({
			calls: calls7,
			handlers: baseHandlers({
				'sys_Storage.getExtensionUserConfig': args =>
					(storage7.has(String(args[0])) ? storage7.get(String(args[0])) : undefined),
				'sys_Storage.setExtensionUserConfig': args => {
					storage7.set(String(args[0]), args[1]);
					return Promise.resolve(true);
				},
				'sys_IFrame.openIFrame': args => {
					iframeCalls7.push(args);
					// 模拟 iframe 页面：异步写心跳 + 结果（与 config.html 行为一致）
					setTimeout(() => {
						storage7.set('delivery-ui-alive', JSON.stringify(Date.now()));
						storage7.set('delivery-ui-result', JSON.stringify({
							selected: ['cplFilter', 'schematicPdf', 'step'],
							outputDir: ROOT7,
							finishedAt: Date.now(),
						}));
					}, 5);
					return Promise.resolve(true);
				},
				'sys_IFrame.closeIFrame': () => Promise.resolve(true),
				'sys_Dialog.showSelectDialog': args => { select7.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': args => { info7.push(args); return undefined; },
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_FileSystem.existsPathInFileSystem': () => Promise.resolve(false),
				'sys_FileSystem.createDirectoryInFileSystem': () => Promise.resolve(true),
				'sys_FileSystem.saveFileToFileSystem': args => {
					written7.push({ path: String(args[0]) });
					return Promise.resolve(true);
				},
			}),
		}),
		// iframe 轮询依赖真实计时器（压缩到 25ms）
		setTimeoutImpl: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 25)),
	});

	console.log('\n[7a] 自定义窗口可用 → 平铺窗口接管配置');
	ctx7.edaEsbuildExportName.exportDeliveryPackage();

	for (let i = 0; i < 120 && info7.length === 0; i++)
		await sleep(25);

	check('完全没有使用下拉选择框（showSelectDialog 零调用）', select7.length === 0,
		`实际=${select7.length}`);
	check('打开了自定义配置窗口', iframeCalls7.length === 1,
		`实际=${iframeCalls7.length}`);
	check('窗口加载的是扩展包内的 config.html',
		iframeCalls7.length === 1 && iframeCalls7[0][0] === '/iframe/config.html',
		`实际=${iframeCalls7.map(a => a[0]).join(' | ')}`);

	const dirPrefix7 = `Demo Board_${localYmd()}`;
	const gerber7 = written7.find(w => w.path.endsWith(`${dirPrefix7}/Demo Board_Gerber.zip`));
	check('导出完成：Gerber 落在日期子目录（非平铺）', Boolean(gerber7),
		`实际=${written7.map(w => w.path).join(' | ')}`);
	check('未勾选的交互式 BOM / 工程文件没有导出',
		written7.every(w => !w.path.endsWith('.html') && !w.path.endsWith('.epro2') && !w.path.endsWith('.epro')),
		`实际=${written7.map(w => w.path).join(' | ')}`);

	eq('完成窗口弹出', info7.length, 1);
	if (info7.length === 1)
		has('完成窗口显示实际目录', info7[0][0], ROOT7);

	// 设置以 JSON 字符串持久化（v1.4.0 起的存储格式），且勾选结果被如实保存
	const savedRaw7 = storage7.get('delivery-settings');
	check('设置已持久化（值为 JSON 字符串）', typeof savedRaw7 === 'string' && savedRaw7.length > 2,
		`实际类型=${typeof savedRaw7}`);
	let saved7 = null;
	try {
		saved7 = JSON.parse(savedRaw7);
	}
	catch {
		/* ignore */
	}
	check('勾选结果被保存（cplFilter=true, iBOM=false）',
		saved7 !== null
		&& saved7.cplFilterEnabled === true
		&& saved7.exportSchematicPdf === true
		&& saved7.exportInteractiveBom === false,
		`实际=${JSON.stringify(saved7)}`);
	check('输出目录被保存', saved7 !== null && saved7.outputDir === ROOT7,
		`实际=${JSON.stringify(saved7 && saved7.outputDir)}`);
}

/* ================================================================== *
 * 场景 8：sys_IFrame 打不开 → 自动回退官方弹窗链
 *
 * 自定义窗口不是硬依赖：openIFrame 返回 false（或缺失 / 抛错）时，
 * 必须无缝回落到 showSelectDialog 弹窗链，导出能力不受影响。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 8：自定义窗口不可用时回退官方弹窗链');
console.log('='.repeat(64));

{
	const select8 = [];
	const iframeCalls8 = [];
	// 存储桥必须是「可用的」：本场景只让 openIFrame 返回 false，
	// 单独验证「窗口打不开」这一条回退路径
	const storage8 = new Map();

	const ctx8 = loadSandbox({
		eda: makeEda({
			handlers: baseHandlers({
				'sys_Storage.getExtensionUserConfig': args =>
					(storage8.has(String(args[0])) ? storage8.get(String(args[0])) : undefined),
				'sys_Storage.setExtensionUserConfig': args => {
					storage8.set(String(args[0]), args[1]);
					return Promise.resolve(true);
				},
				'sys_IFrame.openIFrame': args => { iframeCalls8.push(args); return Promise.resolve(false); },
				'sys_Dialog.showSelectDialog': args => { select8.push(args); return undefined; },
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
			}),
		}),
	});

	console.log('\n[8a] openIFrame 返回 false');
	ctx8.edaEsbuildExportName.exportDeliveryPackage();
	for (let i = 0; i < 20; i++)
		await tick();

	check('确实尝试过打开自定义窗口', iframeCalls8.length === 1, `实际=${iframeCalls8.length}`);
	eq('回退后弹出官方配置弹窗', select8.length, 1);
	const values8 = (select8[0]?.[0] ?? []).map(o => o.value);
	check('回退弹窗的选项键集合完整（含 changeOutputDir 动作项）',
		['cplFilter', 'schematicPdf', 'step', 'interactiveBom', 'projectV3', 'projectV2', 'runDrc', 'changeOutputDir']
			.every(k => values8.includes(k)),
		`实际=${JSON.stringify(values8)}`);
}


/* ================================================================== *
 * 场景 9：`setExtensionUserConfig` 返回 `undefined`（什么都不返回）
 *
 * 官方签名是 Promise<boolean>，但各端实现并不统一（见过 boolean / Promise /
 * undefined 三种）。主脚本必须以「写后读回一致」为准，而不是看返回值 ——
 * 否则一遇到不按签名返回的实现，自定义窗口就会被误判为不可用。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 9：存储接口不按签名返回值时，自定义窗口仍要能用');
console.log('='.repeat(64));

{
	const ROOT9 = 'D:/PCB_Out';
	const storage9 = new Map();
	const iframeCalls9 = [];
	const select9 = [];
	const info9 = [];
	const written9 = [];

	const ctx9 = loadSandbox({
		eda: makeEda({
			handlers: baseHandlers({
				'sys_Storage.getExtensionUserConfig': args =>
					(storage9.has(String(args[0])) ? storage9.get(String(args[0])) : undefined),
				// 关键：存住了，但**什么都不返回**
				'sys_Storage.setExtensionUserConfig': args => {
					storage9.set(String(args[0]), args[1]);
					return undefined;
				},
				'sys_IFrame.openIFrame': args => {
					iframeCalls9.push(args);
					// 模拟页面：同步写心跳 + 结果
					storage9.set('delivery-ui-alive', JSON.stringify(Date.now()));
					storage9.set('delivery-ui-result', JSON.stringify({
						selected: ['cplFilter', 'schematicPdf'],
						outputDir: ROOT9,
						finishedAt: Date.now(),
					}));
					return Promise.resolve(true);
				},
				'sys_IFrame.closeIFrame': () => Promise.resolve(true),
				'sys_Dialog.showSelectDialog': args => { select9.push(args); return undefined; },
				'sys_Dialog.showInformationMessage': args => { info9.push(args); return undefined; },
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
				'sys_FileSystem.existsPathInFileSystem': () => Promise.resolve(false),
				'sys_FileSystem.createDirectoryInFileSystem': () => Promise.resolve(true),
				'sys_FileSystem.saveFileToFileSystem': args => {
					written9.push({ path: String(args[0]) });
					return Promise.resolve(true);
				},
			}),
		}),
	});

	console.log('\n[9a] 存储写入返回 undefined（非标准实现）');
	ctx9.edaEsbuildExportName.exportDeliveryPackage();
	for (let i = 0; i < 60 && info9.length === 0; i++)
		await sleep(30);

	eq('仍然打开了自定义窗口', iframeCalls9.length, 1);
	eq('没有回退到下拉弹窗', select9.length, 0);
	check('导出真的产出了文件', written9.length > 0,
		`实际=${written9.map(w => w.path).join(' | ')}`);
	eq('完成窗口弹出', info9.length, 1);
	if (info9.length === 1)
		has('完成窗口显示实际目录', info9[0][0], ROOT9);
}

/* ================================================================== *
 * 场景 10：窗口桥失败后不再重复弹（用户反馈「关闭重开还是这样」）
 *
 * 桥一旦确认不可用，就按客户端版本记住；同版本下后续直接走官方弹窗链，
 * 客户端升级后（版本号变化）自动再试一次自定义窗口。
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('场景 10：桥失败后同版本不再重复弹自定义窗口');
console.log('='.repeat(64));

{
	const storage10 = new Map();
	const iframeCalls10 = [];
	const select10 = [];

	const ctx10 = loadSandbox({
		eda: makeEda({
			handlers: baseHandlers({
				'sys_Storage.getExtensionUserConfig': args =>
					(storage10.has(String(args[0])) ? storage10.get(String(args[0])) : undefined),
				'sys_Storage.setExtensionUserConfig': args => {
					storage10.set(String(args[0]), args[1]);
					return Promise.resolve(true);
				},
				// 窗口接口存在，但调用直接抛错 —— 模拟「打不开」
				'sys_IFrame.openIFrame': args => {
					iframeCalls10.push(args);
					throw new Error('openIFrame 在本机不可用');
				},
				'sys_Dialog.showSelectDialog': args => { select10.push(args); return undefined; },
				'sys_FileSystem.getDocumentsPath': () => Promise.resolve('C:/Users/qixia/Documents'),
			}),
		}),
	});

	console.log('\n[10a] 第一次：窗口打不开 → 回退弹窗链并记下失败');
	ctx10.edaEsbuildExportName.exportDeliveryPackage();
	for (let i = 0; i < 30 && select10.length === 0; i++)
		await tick();

	eq('尝试过一次自定义窗口', iframeCalls10.length, 1);
	eq('回退后弹出官方配置弹窗', select10.length, 1);

	const markerRaw = storage10.get('delivery-ui-broken');
	check('已记下「本版本桥不可用」标记', typeof markerRaw === 'string' && markerRaw.length > 2,
		`实际=${String(markerRaw)}`);
	let marker10 = null;
	try { marker10 = JSON.parse(markerRaw); }
	catch { /* ignore */ }
	eq('标记里记录的是当前客户端版本', marker10 && marker10.version, '3.2.15-test');

	console.log('\n[10b] 第二次（同一次会话、同一版本）：不得再弹那个坏窗口');
	select10.length = 0;
	ctx10.edaEsbuildExportName.exportDeliveryPackage();
	for (let i = 0; i < 30 && select10.length === 0; i++)
		await tick();

	eq('自定义窗口没有再被尝试', iframeCalls10.length, 1);
	eq('直接给出官方配置弹窗', select10.length, 1);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`PASS: ${passed}   FAIL: ${failures.length}`);
if (failures.length > 0) {
	for (const f of failures)
		console.log(`  - ${f}`);
	process.exitCode = 1;
}
else {
	console.log('全部通过 ✅');
}
console.log('='.repeat(64));

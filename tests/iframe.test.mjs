/**
 * iframe.test.mjs —— 真实执行 /iframe/config.html 的内联脚本
 *
 * ## 为什么需要这个文件
 * `flow.test.mjs` 只 mock 了 `eda`，config.html 的 JS **从未被执行过**，
 * 因此 v1.4.0 那个致命 bug 逃过了所有测试：
 *
 *   `eda.sys_Storage.setExtensionUserConfig(...)` 官方返回 **Promise<boolean>**，
 *   而 config.html 写了 `... === true` —— Promise 永远不等于 `true`，
 *   于是**每个客户端**都显示「无法写入扩展存储」并禁用「浏览 / 开始导出」按钮。
 *
 * 本文件用一个最小 DOM 桩真实跑一遍页面脚本，
 * mock 的 `setExtensionUserConfig` 严格按官方签名返回 Promise，
 * 从而把这类「返回值形态」问题钉死在测试里。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const HTML_PATH = join(PROJECT, 'iframe', 'config.html');

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
	if (cond) {
		passed++;
		console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
	}
	else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

function eq(name, actual, expected) {
	ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * 最小 DOM 桩
 * ------------------------------------------------------------------ */
function escapeHtml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

class El {
	constructor(id) {
		this.id = id;
		this._text = '';
		this._html = '';
		this.value = '';
		this.checked = false;
		this.disabled = false;
		this.style = {};
		this._cls = new Set();
		this._handlers = {};
		this._attr = {};
		const cls = this._cls;
		this.classList = {
			add: v => cls.add(v),
			remove: v => cls.delete(v),
			contains: v => cls.has(v),
			toggle: (v, force) => {
				const on = force === undefined ? !cls.has(v) : Boolean(force);
				if (on)
					cls.add(v);
				else
					cls.delete(v);
				return on;
			},
		};
	}

	get textContent() { return this._text; }

	set textContent(v) { this._text = String(v); this._html = escapeHtml(this._text); }

	get innerHTML() { return this._html; }

	set innerHTML(v) {
		this._html = String(v);
		if (this.id === 'options')
			registerOptions(this._html);
	}

	addEventListener(event, fn) {
		(this._handlers[event] = this._handlers[event] || []).push(fn);
	}

	click() {
		for (const fn of this._handlers.click || [])
			fn.call(this);
	}

	focus() { /* noop */ }

	getAttribute(key) { return key in this._attr ? this._attr[key] : null; }

	setAttribute(key, value) { this._attr[key] = String(value); }

	querySelectorAll() { return []; }
}

const REQUIRED_IDS = [
	'error-bar', 'title', 'mandatory', 'options', 'dir-title', 'dir', 'browse',
	'dir-hint', 'browser', 'browser-bar', 'browser-path', 'browser-list',
	'browser-msg', 'up', 'roots', 'use', 'cancel', 'start', 'dir-row', 'actions',
	'progress', 'progress-track', 'progress-bar', 'progress-percent', 'progress-message',
];

/** 从 options 的 innerHTML 里识别复选框，供 getElementById('opt-xxx') 使用 */
function registerOptions(html) {
	const re = /<input[^>]*id="opt-([^"]+)"([^>]*)>/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		const key = m[1];
		const rest = m[2] || '';
		const el = document.getElementById(`opt-${key}`);
		el.checked = /\bchecked\b/.test(rest);
	}
}

const document = {
	_elements: new Map(),
	getElementById(id) {
		if (!this._elements.has(id))
			this._elements.set(id, new El(id));
		return this._elements.get(id);
	},
	createElement() { return new El(''); },
};

function resetDom() {
	document._elements = new Map();
	for (const id of REQUIRED_IDS)
		document.getElementById(id);
}

function $(id) { return document.getElementById(id); }

/* ------------------------------------------------------------------ *
 * 提取并执行 config.html 的内联脚本
 * ------------------------------------------------------------------ */
function extractScript(html) {
	const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
	if (blocks.length === 0)
		throw new Error('config.html 里没有找到 <script> 块');
	return blocks[blocks.length - 1][1];
}

async function runPage({ storage, fs = {}, preloadEdition }) {
	resetDom();

	const closed = [];
	const eda = {
		sys_Storage: {
			getExtensionUserConfig: key => (storage.has(String(key)) ? storage.get(String(key)) : undefined),
			// 严格按官方签名：返回 Promise<boolean>
			setExtensionUserConfig: (key, value) => {
				storage.set(String(key), value);
				return Promise.resolve(true);
			},
		},
		sys_IFrame: {
			closeIFrame: (id) => { closed.push(id); return Promise.resolve(true); },
		},
		sys_FileSystem: fs,
	};

	const windowStub = { prompt: () => null };
	const code = extractScript(readFileSync(HTML_PATH, 'utf8'));

	// eslint-disable-next-line no-new-func
	new Function(
		'eda', 'document', 'window', 'setTimeout', 'setInterval', 'clearInterval',
		'clearTimeout', 'setImmediate', 'console', 'preloadEdition',
		code,
	)(eda, document, windowStub, setTimeout, setInterval, clearInterval, clearTimeout,
		undefined, console, preloadEdition);

	await sleep(60);
	return { closed, eda };
}

/* ================================================================== *
 * 用例 1：官方返回 Promise —— 窗口必须正常工作
 *
 * 这是 v1.4.0 真机事故的回归：旧代码用 `=== true` 判定 Promise，
 * 结果每个客户端都误报「无法写入扩展存储」并禁用按钮。
 * ================================================================== */

console.log('iframe.config.html — 场景 1：setExtensionUserConfig 返回 Promise（真机形态）');
console.log('='.repeat(64));

{
	const storage = new Map();
	// 与 src/ui.ts 的 openConfigIframe 生成的载荷保持一致：
	// 勾选状态用「选项键数组」，目录单独给 outputDir
	storage.set('delivery-ui-request', JSON.stringify({
		settings: {
			cplFilterEnabled: true,
			exportSchematicPdf: true,
			exportStep: true,
			exportInteractiveBom: false,
			exportProjectV3: true,
			exportProjectV2: false,
			outputDir: 'D:/PCB_Out',
		},
		selected: ['cplFilter', 'schematicPdf', 'step', 'projectV3'],
		outputDir: 'D:/PCB_Out',
		iframeId: 'test-iframe',
		interactiveBomSupported: true,
		folderPathPickerSupported: true,
	}));

	const { closed } = await runPage({ storage });

	console.log('\n[1a] 心跳：写后读回校验');
	eq('心跳已写入 storage', typeof storage.get('delivery-ui-alive'), 'string');
	eq('没有显示错误条', $('error-bar').style.display || '', '');
	eq('「开始导出」按钮可用', $('start').disabled, false);
	eq('「浏览」按钮可用', $('browse').disabled, false);
	eq('有原生目录接口时显示「浏览」按钮', $('browse').style.display || '', '');

	console.log('\n[1b] 渲染：选项平铺、目录带出');
	const optsHtml = $('options').innerHTML;
	ok('CPL 过滤复选框已渲染并默认勾选',
		$('opt-cplFilter').checked === true && optsHtml.includes('id="opt-cplFilter"'),
		`checked=${$('opt-cplFilter').checked}`);
	ok('原理图 PDF 已渲染并勾选', $('opt-schematicPdf').checked === true);
	ok('交互式 BOM 未勾选（设置里为 false）', $('opt-interactiveBom').checked === false);
	ok('工程文件 V2 未勾选', $('opt-projectV2').checked === false);
	eq('输出目录已带出', $('dir').value, 'D:/PCB_Out');

	console.log('\n[1c] 点「开始导出」→ 结果必须回传到主脚本');
	$('start').click();
	await sleep(60);

	const raw = storage.get('delivery-ui-result');
	let payload = null;
	try { payload = JSON.parse(raw); }
	catch { /* ignore */ }

	ok('结果已写入 delivery-ui-result', payload !== null, `原始=${String(raw)}`);
	eq('回传的目录正确', payload && payload.outputDir, 'D:/PCB_Out');
	ok('回传的勾选项与界面一致',
		!!payload && Array.isArray(payload.selected)
		&& payload.selected.includes('cplFilter')
		&& payload.selected.includes('schematicPdf')
		&& !payload.selected.includes('interactiveBom')
		&& !payload.selected.includes('projectV2'),
		`实际=${JSON.stringify(payload && payload.selected)}`);
	eq('导出期间窗口保持打开', closed.length, 0);
	eq('已切换到进度视图', $('progress').style.display, 'block');
	storage.set('delivery-ui-progress', JSON.stringify({ percent: 36, message: '正在导出 BOM…', done: true }));
	await sleep(300);
	eq('进度条更新到主脚本给出的百分比', $('progress-bar').style.width, '36%');
	eq('进度文字同步更新', $('progress-percent').textContent, '36%');
	eq('当前步骤同步更新', $('progress-message').textContent, '正在导出 BOM…');
}

/* ================================================================== *
 * 用例 2：目录没填 → 必须拦下并提示，不能静默写空目录
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('iframe.config.html — 场景 2：目录为空时不得提交');
console.log('='.repeat(64));

{
	const storage = new Map();
	storage.set('delivery-ui-request', JSON.stringify({
		settings: { outputDir: '' },
		iframeId: 'test-iframe',
		interactiveBomSupported: true,
	}));

	const { closed } = await runPage({ storage });

	eq('无原生目录路径接口时隐藏无效的「浏览」按钮', $('browse').style.display, 'none');
	ok('旧客户端明确提示手动填写完整路径',
		/完整路径|full path manually/.test($('dir-hint').textContent),
		`实际=${$('dir-hint').textContent}`);

	$('dir').value = '';
	$('start').click();
	await sleep(40);

	eq('没有写入结果', storage.has('delivery-ui-result'), false);
	eq('窗口没有关闭（留在界面上让用户改）', closed.length, 0);
	ok('给出了明确的错误提示', /有效的绝对路径|Invalid absolute path/.test($('dir-hint').innerHTML),
		`实际=${$('dir-hint').innerHTML.slice(0, 80)}`);
}

/* ================================================================== *
 * 用例 3：浏览 —— 本机没有 openReadFolderPathDialog，
 *         必须落到 openReadFolderDialog 并由 File.path 反推目录
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('iframe.config.html — 场景 3：浏览按钮在旧客户端上仍能拿到目录');
console.log('='.repeat(64));

{
	const storage = new Map();
	storage.set('delivery-ui-request', JSON.stringify({
		settings: { outputDir: '' },
		iframeId: 'test-iframe',
		interactiveBomSupported: true,
	}));

	await runPage({ storage });

	$('browse').click();
	await sleep(60);
	const request = JSON.parse(storage.get('delivery-ui-browse-request'));
	storage.set('delivery-ui-browse-result', JSON.stringify({
		id: request.id,
		dir: 'D:\\work\\target',
		how: 'openReadFolderDialog',
	}));
	await sleep(300);

	eq('目录已由主脚本浏览桥传回', $('dir').value, 'D:\\work\\target');
	ok('界面上说明了来源', /openReadFolderDialog/.test($('dir-hint').innerHTML),
		`实际=${$('dir-hint').innerHTML.slice(0, 80)}`);
}

/* ================================================================== *
 * 用例 4：连 openReadFolderDialog 也拿不到路径 → 不强迫用户选择文件
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('iframe.config.html — 场景 4：文件夹选择框无路径时保留手填');
console.log('='.repeat(64));

{
	const storage = new Map();
	storage.set('delivery-ui-request', JSON.stringify({
		settings: { outputDir: '' },
		iframeId: 'test-iframe',
		interactiveBomSupported: true,
	}));

	await runPage({ storage });

	$('browse').click();
	await sleep(60);
	const request = JSON.parse(storage.get('delivery-ui-browse-request'));
	storage.set('delivery-ui-browse-result', JSON.stringify({ id: request.id, dir: '', how: 'cancelled' }));
	await sleep(300);

	eq('目录输入保持不变', $('dir').value, '');
	ok('取消后给出可操作提示', /未选择目录|重试|填写路径/.test($('dir-hint').innerHTML),
		`实际=${$('dir-hint').innerHTML.slice(0, 100)}`);
}

/* ================================================================== *
 * 用例 5：静态回归 —— 绝不允许再出现 `=== true` 判定存储写入
 * （这是 v1.4.0 事故的直接成因，用源码级断言锁死）
 * ================================================================== */

console.log(`\n${'='.repeat(64)}`);
console.log('iframe.config.html — 场景 5：静态回归（禁止用返回值判定写入成功）');
console.log('='.repeat(64));

{
	const html = readFileSync(HTML_PATH, 'utf8');
	const script = extractScript(html);

	ok('不存在 `setExtensionUserConfig(...) === true` 形式的判定',
		!/setExtensionUserConfig[\s\S]{0,200}===\s*true/.test(script),
		'若命中说明又回到了 v1.4.0 的错误写法');
	ok('写入后做了读回校验',
		/getExtensionUserConfig\(key\)/.test(script) && /String\(back\)\s*===\s*String\(text\)/.test(script),
		'必须有「写后读回一致」这一唯一可靠判据');
	ok('浏览链覆盖了 openReadFolderDialog', /openReadFolderDialog/.test(script));
	ok('浏览链明确禁止退回文件选择框', /不使用 openReadFileDialog 降级/.test(script));
	ok('浏览链保留了原生 openReadFolderPathDialog 优先', /openReadFolderPathDialog/.test(script));
	ok('提交失败会显式告知用户而不是静默', /无法把设置传回插件/.test(script));
	ok('界面提示英文 iBOM 跟随 EasyEDA 语言',
		html.includes('Switch EasyEDA to English before exporting an English interactive BOM.'),
		'应包含英文导出提示');
	ok('主界面底部显示作者和联系邮箱',
		html.includes('Author: kingmacth') && html.includes('kingmacth@gmail.com'),
		'应包含作者名与邮箱');
}

console.log(`\n${'='.repeat(64)}`);
console.log(`PASS: ${passed}   FAIL: ${failed}`);
console.log('='.repeat(64));

if (failed > 0)
	process.exit(1);

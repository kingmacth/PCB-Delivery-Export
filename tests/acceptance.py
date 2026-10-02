"""对最终 .eext 交付包做全面验收检查。

用法：
    python tests/acceptance.py [path/to/xxx.eext]
不给参数时：优先取仓库根目录下的 *.eext，其次取 build/dist/*.eext。
需要先执行 `npm run build`。
"""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

PROJ = Path(__file__).resolve().parent.parent


def resolve_eext() -> Path:
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    candidates = list(PROJ.parent.glob('*.eext')) + list((PROJ / 'build' / 'dist').glob('*.eext'))
    if not candidates:
        raise SystemExit('找不到 .eext；请先执行 npm run build，或把其路径作为第一个参数传入')
    # 按修改时间选最新的一个：同一目录下新旧包共存时，
    # 若按文件名排序会误选旧版本，导致“实际没验收到新代码”。
    return max(candidates, key=lambda f: f.stat().st_mtime)


EEXT = resolve_eext()

results = []


def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  — {extra}' if extra and not cond else ''))


print('=' * 72)
print(f'交付包验收检查  {EEXT.name}')
print('=' * 72)

# ---------- 1. 包结构 ----------
print('\n[1] 包内容结构')
with zipfile.ZipFile(EEXT) as z:
    names = sorted(z.namelist())
    ext_json = json.loads(z.read('extension.json').decode('utf-8'))
    dist_js = z.read('dist/index.js').decode('utf-8')
    locales_zh = json.loads(z.read('locales/zh-Hans.json').decode('utf-8'))
    locales_en = json.loads(z.read('locales/en.json').decode('utf-8'))
    locales_ext_zh = json.loads(z.read('locales/extensionJson/zh-Hans.json').decode('utf-8'))
    locales_ext_en = json.loads(z.read('locales/extensionJson/en.json').decode('utf-8'))
    logo_bytes = z.read('images/logo.png')
    has_logo = bool(logo_bytes)
    logo_sha256 = hashlib.sha256(logo_bytes).hexdigest()
    changelog = z.read('CHANGELOG.md').decode('utf-8') if 'CHANGELOG.md' in names else ''

# v1.4.0 起配置窗口为 /iframe/config.html（平铺复选框 + 浏览按钮），
# SDK 模板自带的示例页 iframe/index.html 已移除。
required = ['extension.json', 'dist/index.js', 'images/logo.png', 'iframe/config.html',
            'locales/zh-Hans.json', 'locales/en.json',
            'locales/extensionJson/zh-Hans.json', 'locales/extensionJson/en.json',
            'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE']
for r in required:
    check(f'包含 {r}', r in names)

check('不含 src/ 源码', not any(n.startswith('src/') for n in names))
check('不含 tests/ 测试', not any(n.startswith('tests/') for n in names))
check('不含 node_modules/', not any('node_modules' in n for n in names))
check('logo.png 非空', has_logo)
check('logo.png 不是 SDK 默认 Logo',
      logo_sha256 != 'ef1a173637a9260d5e2171bc3cf98ea0a3a6649022e3111b063e54a418c9ce22',
      logo_sha256)
check('CHANGELOG.md 包含当前版本更新说明', f'# PCB Delivery Export {ext_json.get("version")}' in changelog)
print(f'        包内文件 {len(names)} 个；总大小 {EEXT.stat().st_size} 字节')

# ---------- 2. extension.json ----------
print('\n[2] extension.json 字段合法性')
name = ext_json.get('name', '')
check('name 仅含小写字母/数字/连字符', bool(re.fullmatch(r'[a-z0-9-]+', name)), name)
check('name 长度 5-30', 5 <= len(name) <= 30, f'长度={len(name)}')
check('name == pcb-delivery-export', name == 'pcb-delivery-export', name)

uuid = ext_json.get('uuid', '')
check('uuid 为 32 位小写字母+数字', bool(re.fullmatch(r'[a-z0-9]{32}', uuid)), uuid)
check('uuid 非全零占位', uuid != '0' * 32, uuid)

ver = ext_json.get('version', '')
check('version 为 major.minor.patch', bool(re.fullmatch(r'\d+\.\d+\.\d+', ver)), ver)
pkg_version = json.loads((PROJ / 'package.json').read_text(encoding='utf-8'))['version']
check(f'version 符合 semver ({ver})', bool(re.fullmatch(r'\d+\.\d+\.\d+', str(ver))), ver)
check('version 与 package.json 一致', ver == pkg_version, f'{ver} vs {pkg_version}')

check('engines.eda 存在', 'eda' in ext_json.get('engines', {}), str(ext_json.get('engines')))
check('engines.eda == >=3.0.0', ext_json.get('engines', {}).get('eda') == '>=3.0.0')
check('entry == ./dist/index', ext_json.get('entry') == './dist/index', str(ext_json.get('entry')))
check('categories 为数组（官方允许 string | Array）', isinstance(ext_json.get('categories'), list))
check('categories 含 PCB', 'PCB' in ext_json.get('categories', []))
check('images.logo 指向存在文件', ext_json.get('images', {}).get('logo') == './images/logo.png')

# ---------- 3. 菜单注册 ----------
print('\n[3] headerMenus 菜单注册')
menus = ext_json.get('headerMenus', {})
check('存在 pcb 菜单组', 'pcb' in menus, str(list(menus.keys())))
groups = menus.get('pcb', [])
check('pcb 组为数组', isinstance(groups, list))

group_ids = [g.get('id') for g in groups]
check('菜单组 id 唯一', len(group_ids) == len(set(group_ids)), str(group_ids))

items = []
for g in groups:
    check(f'组 {g.get("id")} 有 title', bool(g.get('title')))
    for it in g.get('menuItems', []):
        items.append(it)

item_ids = [i.get('id') for i in items]
check('菜单项 id 唯一', len(item_ids) == len(set(item_ids)), str(item_ids))
check(f'菜单项共 {len(items)} 个（每个都有 id/title/registerFn）',
      len(items) == 1 and all(i.get('id') and i.get('title') and i.get('registerFn') for i in items),
      str(item_ids))

regfns = [i.get('registerFn') for i in items]
check('registerFn 包含 exportDeliveryPackage', 'exportDeliveryPackage' in regfns, str(regfns))
check('已移除环境自检与接口连通性实测菜单',
      'selfCheck' not in regfns and 'liveApiTest' not in regfns, str(regfns))

# ---------- 4. 打包产物 ----------
print('\n[4] dist/index.js 打包产物')
check('为 IIFE（无顶层 import 语句）', not re.search(r'^\s*import\s', dist_js, re.M))
check('无顶层 export 语句', not re.search(r'^\s*export\s', dist_js, re.M))
check('使用约定 globalName edaEsbuildExportName', 'edaEsbuildExportName' in dist_js)
for fn in ['exportDeliveryPackage', 'activate']:
    check(f'含导出函数 {fn}', fn in dist_js)
check('不再导出诊断函数', 'selfCheck' not in dist_js and 'liveApiTest' not in dist_js)

# ---------- 5. 调用到的官方 API ----------
print('\n[5] 官方 API 调用存在性')
apis = [
    'getGerberFile', 'getBomFile', 'getPickAndPlaceFile', 'get3DFile',
    'getInteractiveBomFile',                        # 交互式 BOM
    'getExportDocumentFile',                        # 原理图 PDF
    'getProjectFile',                               # 工程源文件
    'check',                                        # DRC
    'createDirectoryInFileSystem', 'saveFileToFileSystem', 'existsPathInFileSystem',
    'getDocumentsPath', 'openReadFolderPathDialog', 'openReadFilePathDialog',
    'listFilesOfFileSystem',                       # 降级：列目录判断占用
    'showInputDialog',                             # 降级：手填输出目录 'openReadFilePathDialog',
    'listFilesOfFileSystem',                       # 降级：列目录判断占用
    'showInputDialog',                             # 降级：手填输出目录
    'showInformationMessage', 'showConfirmationMessage', 'showSelectDialog',
    'showToastMessage', 'getExtensionUserConfig', 'setExtensionUserConfig',
    'getCurrentBoardInfo', 'getPcbInfo', 'getCurrentProjectInfo',
    'getCurrentDocumentInfo', 'getEditorCurrentVersion',
]
missing = [a for a in apis if a not in dist_js]
check(f'{len(apis)} 个官方 API 全部出现', not missing, str(missing))

# ---------- 6. 禁止项扫描 ----------
print('\n[6] 禁止项扫描（任务书第 26 节）')
forbidden = {
    '.click(': '模拟鼠标点击',
    'querySelector': 'DOM 查询',
    'dispatchEvent': '伪造事件',
    'ESYS_Unit.': '运行时枚举引用',
    'EPCB_LayerId.': '运行时枚举引用',
    'esbuildExportName.exportDeliveryPackage =': '覆盖导出',
}
for pat, desc in forbidden.items():
    hits = dist_js.count(pat)
    check(f'无「{desc}」({pat})', hits == 0, f'出现 {hits} 次')

# ---------- 7. 通知降级链 ----------
print('\n[7] 通知降级链完整')
for ch in ['sys_Dialog', 'sys_MessageBox', 'sys_Message', 'alert', 'console']:
    check(f'降级链含 {ch}', ch in dist_js)

# ---------- 8. 多语言覆盖 ----------
print('\n[8] 多语言覆盖完整性')
src_text = '\n'.join(p.read_text(encoding='utf-8') for p in (PROJ / 'src').glob('*.ts'))
tags = set()
for m in re.finditer(r"""\bt\(\s*(['"])((?:\\.|(?!\1).)*?)\1""", src_text, re.S):
    v = m.group(2).replace('\\\\', '\\').replace("\\'", "'").replace('\\"', '"').replace('\\n', '\n')
    if v.strip():
        tags.add(v)

miss_zh = sorted(t for t in tags if t not in locales_zh)
miss_en = sorted(t for t in tags if t not in locales_en)
check(f'中文语言文件覆盖全部 {len(tags)} 个标签', not miss_zh, str(miss_zh[:5]))
check(f'英文语言文件覆盖全部 {len(tags)} 个标签', not miss_en, str(miss_en[:5]))
check('中文环境必有「一键导出」', locales_ext_zh.get('Export Delivery Package') == '一键导出')

# ---------- 汇总 ----------
print('\n' + '=' * 72)
ok = sum(1 for _, c, _ in results if c)
bad = len(results) - ok
print(f'检查项: {len(results)}   通过: {ok}   失败: {bad}')
if bad:
    print('\n失败明细：')
    for n, c, e in results:
        if not c:
            print(f'  - {n}  {e}')
print('ALL CHECKS PASSED' if bad == 0 else 'SOME CHECKS FAILED')
print('=' * 72)
print(f'\nSHA256: {hashlib.sha256(EEXT.read_bytes()).hexdigest()}')
sys.exit(1 if bad else 0)

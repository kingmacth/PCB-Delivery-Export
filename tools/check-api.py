"""从 pro-api-types 提取每个 API 类的公开方法清单，用于核对插件实际调用的方法是否存在。

用法：在项目根目录执行 `python tools/check-api.py`
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
T = ROOT / 'node_modules' / '@jlceda' / 'pro-api-types' / 'index.d.ts'
if not T.exists():
    raise SystemExit(f'找不到类型定义：{T}（请先 npm install）')
src = T.read_text(encoding='utf-8')
lines = src.split('\n')

# 收集 class 起始行
class_starts = []
for i, l in enumerate(lines):
    m = re.match(r'^\tclass ([A-Za-z0-9_]+)', l)
    if m:
        class_starts.append((i, m.group(1)))

def body_range(start):
    """从 class 起始行开始，用花括号计数找到类体范围"""
    depth = 0
    started = False
    for i in range(start, len(lines)):
        depth += lines[i].count('{') - lines[i].count('}')
        if '{' in lines[i]:
            started = True
        if started and depth <= 0:
            return start, i
    return start, len(lines) - 1

# 提取方法：public name(  或 name(  （跳过 private / constructor）
methods = {}
for idx, (start, name) in enumerate(class_starts):
    end = class_starts[idx + 1][0] if idx + 1 < len(class_starts) else len(lines)
    s, e = body_range(start)
    e = min(e, end)
    found = []
    for l in lines[s:e + 1]:
        stripped = l.strip()
        if stripped.startswith('private') or stripped.startswith('protected'):
            continue
        for m in re.finditer(r'\bpublic\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', stripped):
            if m.group(1) != 'constructor':
                found.append(m.group(1))
        # 无 public 前缀但有类型的成员方法（d.ts 里通常带 public）
    if found:
        methods[name] = sorted(set(found))

# 插件实际调用的 (访问器, 方法) 列表
used = {
    'SYS_Log': ['add'],
    'SYS_I18n': ['text'],
    'SYS_Dialog': ['showInformationMessage', 'showConfirmationMessage', 'showSelectDialog',
                   'showInputDialog'],
    'SYS_MessageBox': ['showInformationMessage'],
    # v1.4.0 起配置窗口优先走 sys_IFrame 自定义窗口（平铺复选框 + 浏览按钮），
    # 与主脚本经 sys_Storage 桥通信；弹窗链降级为回退路径。
    'SYS_IFrame': ['openIFrame', 'closeIFrame'],
    'SYS_Storage': ['getExtensionUserConfig', 'setExtensionUserConfig'],
    'SYS_Environment': ['isClient', 'getEditorCurrentVersion'],
    # v1.2.0 起目录能力全部改为运行时探测 + 分级降级，因此这里列出的是
    # 「代码路径上可能真正被调用」的全集，而不是「所有环境都会调用」的核心集。
    'SYS_FileSystem': ['openReadFolderPathDialog', 'openReadFilePathDialog',
                       'createDirectoryInFileSystem', 'existsPathInFileSystem',
                       'listFilesOfFileSystem', 'saveFileToFileSystem', 'getDocumentsPath'],
    'SYS_FileManager': ['getProjectFile'],
    'SYS_Message': ['showToastMessage'],
    'DMT_SelectControl': ['getCurrentDocumentInfo'],
    'DMT_Project': ['getCurrentProjectInfo'],
    'DMT_EditorControl': ['activateDocument', 'openDocument'],
    'DMT_Schematic': ['getAllSchematicPagesInfo'],
    'PCB_ManufactureData': ['getGerberFile', 'getBomFile', 'getPickAndPlaceFile',
                            'get3DFile', 'getInteractiveBomFile'],
    'SCH_ManufactureData': ['getExportDocumentFile'],
    'PCB_Drc': ['check'],
}

print('=' * 72)
print('插件调用的 API 存在性核验（对照 @jlceda/pro-api-types/index.d.ts）')
print('=' * 72)
ok = 0
bad = 0
for cls, names in sorted(used.items()):
    if cls not in methods:
        print(f'\n[?] 类 {cls} 未在类型定义中找到（可能是误用访问器名）')
        bad += len(names)
        continue
    for n in names:
        present = n in methods[cls]
        mark = 'OK  ' if present else 'MISS'
        if present:
            ok += 1
        else:
            bad += 1
        print(f'  [{mark}] eda.{cls}.{n}()')

print()
print(f'存在 {ok} 项 / 缺失 {bad} 项')
print()

print('=' * 72)
print('关键类的完整方法清单')
print('=' * 72)
for cls in ['SYS_Message', 'SYS_ToastMessage', 'SYS_Dialog', 'SYS_FileSystem',
            'PCB_ManufactureData', 'SYS_FileManager']:
    print(f'\n--- {cls} ---')
    ms = methods.get(cls, [])
    buf = []
    for m in ms:
        buf.append(m)
        if len(buf) == 3:
            print('   ', ', '.join(buf))
            buf = []
    if buf:
        print('   ', ', '.join(buf))

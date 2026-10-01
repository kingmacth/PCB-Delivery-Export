"""同步语言文件：补齐源码新增的 t() 标签、清理已无引用的条目、更新清单菜单翻译。

用法（在项目根目录执行）：
    python tools/sync-locales.py

设计原则：
  · 只增补缺失项与删除**确认无源码引用**的条目，不触碰已有译文；
  · 复用 language file 的缩进风格，输出末尾保留换行，便于 diff。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCALES = ROOT / 'locales'

# 源码标签 -> (简体中文, English)。新增标签时在此登记，避免出现「中英同文」的空翻译。
BS = chr(92)
EXAMPLE_PATH_TAG = '例如：D:' + BS + 'PCB_Output'
EXAMPLE_PATH_TAG_EN = 'For example: D:' + BS + 'PCB_Output'

NEW_TAGS = {
    '请注意': (
        '请注意',
        'Please note',
    ),
    '可在配置窗口的「浏览」里逐级选择目录；若该窗口也不可用，请把「接口连通性实测」的报告发给我们。': (
        '可在配置窗口的「浏览」里逐级选择目录；若该窗口也不可用，请把「接口连通性实测」的报告发给我们。',
        'Pick the folder step by step via the Browse button in the config window; if that window is unavailable too, please send us the API connectivity report.',
    ),
    '配置窗口长时间没有返回结果，已按取消处理。': (
        '配置窗口长时间没有返回结果，已按取消处理。',
        'The config window did not respond in time; treated as cancelled.',
    ),
    '必选（始终导出）：': (
        '必选（始终导出）：',
        'Required (always exported): ',
    ),
    'CPL 按 BOM 过滤': (
        'CPL 按 BOM 过滤',
        'Filter CPL by BOM',
    ),
    '原理图 PDF': (
        '原理图 PDF',
        'Schematic PDF',
    ),
    'STEP 3D 模型': (
        'STEP 3D 模型',
        'STEP 3D model',
    ),
    '工程文件 V3  (.epro2)': (
        '工程文件 V3  (.epro2)',
        'Project file V3  (.epro2)',
    ),
    '工程文件 V2  (.epro)': (
        '工程文件 V2  (.epro)',
        'Project file V2  (.epro)',
    ),
    '输出目录…': (
        '输出目录…',
        'Output folder...',
    ),
    '✅ 就用这个目录：': (
        '✅ 就用这个目录：',
        '✅ Use this folder: ',
    ),
    '⬆ 上一级': (
        '⬆ 上一级',
        '⬆ Up one level',
    ),
    '（此目录下没有子文件夹）': (
        '（此目录下没有子文件夹）',
        '（No subfolders here）',
    ),
    '（子文件夹过多，仅显示部分；其余请用手动填写路径）': (
        '（子文件夹过多，仅显示部分；其余请用手动填写路径）',
        '（Too many subfolders - only part is shown; type the path for the rest）',
    ),
    '✏️ 手动输入路径': (
        '✏️ 手动输入路径',
        '✏️ Type a path manually',
    ),
    '💾 换一个磁盘 / 根目录': (
        '💾 换一个磁盘 / 根目录',
        '💾 Switch drive / root',
    ),
    '当前目录': (
        '当前目录',
        'Current folder',
    ),
    '导出时将在此目录下新建子目录：': (
        '导出时将在此目录下新建子目录：',
        'A subfolder will be created here on export: ',
    ),
    '逐级浏览文件夹，选中目标目录后点「✅ 就用这个目录」。': (
        '逐级浏览文件夹，选中目标目录后点「✅ 就用这个目录」。',
        'Browse folders level by level, then click "✅ Use this folder".',
    ),
    '选择一个起始磁盘 / 根目录：': (
        '选择一个起始磁盘 / 根目录：',
        'Choose a starting drive / root folder:',
    ),
    '浏览层级过深，已停止。请改用手动填写路径。': (
        '浏览层级过深，已停止。请改用手动填写路径。',
        'Browsing went too deep and has stopped. Please type the path manually.',
    ),
    '无法列出目录内容，将改用手动填写路径。': (
        '无法列出目录内容，将改用手动填写路径。',
        'Cannot list folder contents; switching to manual path entry.',
    ),
    '目录': (
        '目录',
        'Folder',
    ),
    '该接口需要「外部交互」权限；若已开启仍无响应，请重启 EasyEDA 客户端后重试。': (
        '该接口需要「外部交互」权限；若已开启仍无响应，请重启 EasyEDA 客户端后重试。',
        'This API needs the "External interaction" permission; if it is already on but still unresponsive, restart the EasyEDA client and retry.',
    ),
    '注：当前 EasyEDA 版本没有原生目录选择框，改用「逐级浏览文件夹」选择目录。': (
        '注：当前 EasyEDA 版本没有原生目录选择框，改用「逐级浏览文件夹」选择目录。',
        'Note: this EasyEDA version has no native folder picker; a step-by-step folder browser is used instead.',
    ),
    '注：当前 EasyEDA 版本既无原生目录选择框也无列目录接口，只能手填路径。': (
        '注：当前 EasyEDA 版本既无原生目录选择框也无列目录接口，只能手填路径。',
        'Note: this EasyEDA version has neither a native folder picker nor a folder-listing API; the path must be typed manually.',
    ),
    '选择窗口长时间没有返回结果，已按取消处理。': (
        '选择窗口长时间没有返回结果，已按取消处理。',
        'The selection dialog did not return for a long time; treated as cancelled.',
    ),
    '无法显示选择窗口，将继续尝试其它方式。': (
        '无法显示选择窗口，将继续尝试其它方式。',
        'Could not show the selection dialog; trying another way.',
    ),
    '写入接口没有响应，导出已终止。': (
        '写入接口没有响应，导出已终止。',
        'The write API did not respond; export aborted.',
    ),
    'PCB Delivery Export — 选择输出目录': ('PCB Delivery Export — 选择输出目录', 'PCB Delivery Export — Select Output Folder'),
    EXAMPLE_PATH_TAG: (EXAMPLE_PATH_TAG, EXAMPLE_PATH_TAG_EN),
    '可能原因：': ('可能原因：', 'Possible causes:'),
    '尚未设置输出目录，确定后将引导你选择。': ('尚未设置输出目录，确定后将引导你选择。', 'No output folder set yet — you will be asked to choose one after confirming.'),
    '当前 EasyEDA 版本不支持目录选择框，请直接填写或粘贴输出目录的绝对路径。': (
        '当前 EasyEDA 版本不支持目录选择框，请直接填写或粘贴输出目录的绝对路径。',
        'This EasyEDA version has no folder picker. Please type or paste the absolute path of the output folder.',
    ),
    '当前 EasyEDA 环境无法确定输出目录，导出已终止。': (
        '当前 EasyEDA 环境无法确定输出目录，导出已终止。',
        'Cannot determine the output folder in this EasyEDA environment — export aborted.',
    ),
    '无法显示输入窗口，将继续尝试其它方式。': (
        '无法显示输入窗口，将继续尝试其它方式。',
        'Could not show the input dialog; trying another way.',
    ),
    '未能确定输出目录，本次导出已取消。': (
        '未能确定输出目录，本次导出已取消。',
        'Output folder not determined — this export has been cancelled.',
    ),
    '注：当前 EasyEDA 版本没有目录选择框接口，选择目录时将改用输入框，可直接粘贴路径。': (
        '注：当前 EasyEDA 版本没有目录选择框接口，选择目录时将改用输入框，可直接粘贴路径。',
        'Note: this EasyEDA version has no folder-picker API; choosing a folder will use a text input where you can paste a path.',
    ),
    '留空并确定 = 使用 EDA 文档目录下的 PCB_Delivery': (
        '留空并确定 = 使用 EDA 文档目录下的 PCB_Delivery',
        'Leave empty and confirm = use PCB_Delivery under the EDA documents folder',
    ),
    '留空并确定 = 使用：': ('留空并确定 = 使用：', 'Leave empty and confirm = use: '),
    '输入窗口长时间没有返回结果，已按取消处理。': (
        '输入窗口长时间没有返回结果，已按取消处理。',
        'The input dialog did not return for a long time; treated as cancelled.',
    ),
    '当前 EasyEDA 版本没有可用的目录选择接口，无法指定其它目录。': (
        '当前 EasyEDA 版本没有可用的目录选择接口，无法指定其它目录。',
        'This EasyEDA version provides no folder-picking API, so a different folder cannot be chosen.',
    ),
    '本次将使用：': ('本次将使用：', 'This run will use: '),
    '如需自定义输出位置，请升级 EasyEDA Pro（官方目录选择接口自 EDA v3.2.166 起提供）。': (
        '如需自定义输出位置，请升级 EasyEDA Pro（官方目录选择接口自 EDA v3.2.166 起提供）。',
        'To choose a custom output location, please update EasyEDA Pro (the official folder-picker API ships since EDA v3.2.166).',
    ),
}

# 清单（extension.json 内字符串）的菜单翻译补充
NEW_MENU = {
    'API Connectivity Test': ('接口连通性实测', 'API Connectivity Test'),
}


def collect_source_tags() -> set:
    tags = set()
    for f in (ROOT / 'src').glob('*.ts'):
        text = f.read_text(encoding='utf-8')
        for m in re.finditer(r"""\bt\(\s*'((?:[^'\\]|\\.)*)'""", text):
            raw = m.group(1)
            tags.add(raw.replace('\\\\', '\\').replace("\\'", "'"))
    return tags


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, data: dict) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent='\t', sort_keys=True) + '\n',
        encoding='utf-8',
    )


def sync_language_file(path: Path, index: int, source_tags: set) -> tuple:
    data = read_json(path)
    added, removed = [], []

    for tag in sorted(source_tags):
        pair = NEW_TAGS.get(tag)
        if pair is None:
            if tag not in data:
                # 未登记的新标签：至少不能让界面显示为空
                data[tag] = tag
                added.append(tag)
                print(f'  ⚠ 未登记译文，暂用原文占位: {tag!r}')
            continue
        # 登记表是这些标签的唯一权威，始终写入，以便修正历史占位译文
        if data.get(tag) != pair[index]:
            data[tag] = pair[index]
            added.append(tag)

    for tag in list(data):
        if tag not in source_tags:
            del data[tag]
            removed.append(tag)

    write_json(path, data)
    return added, removed


def main() -> None:
    source_tags = collect_source_tags()
    print(f'源码 t() 标签数: {len(source_tags)}')

    for name, index in (('zh-Hans.json', 0), ('en.json', 1)):
        path = LOCALES / name
        added, removed = sync_language_file(path, index, source_tags)
        print(f'\n[{name}] 新增 {len(added)} 条，清理无引用 {len(removed)} 条，现共 {len(read_json(path))} 条')

    for name, index in (('zh-Hans.json', 0), ('en.json', 1)):
        path = LOCALES / 'extensionJson' / name
        data = read_json(path)
        # 清单里只有仍被 extension.json 引用的字符串需要译文
        manifest = (ROOT / 'extension.json').read_text(encoding='utf-8')
        for key, pair in NEW_MENU.items():
            if key in manifest:
                data[key] = pair[index]
        for key in list(data):
            if key not in manifest:
                del data[key]
        write_json(path, data)
        print(f'[extensionJson/{name}] 现共 {len(data)} 条')

    print('\n语言文件同步完成。')


if __name__ == '__main__':
    main()

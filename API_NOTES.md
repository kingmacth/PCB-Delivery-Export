# API_NOTES.md — EasyEDA Pro 扩展 API 核实记录

本文件记录开发 **PCB Delivery Export** 插件前，对 EasyEDA Pro 官方 Extension API 的核实结果。

## 核实来源（按可信度排序）

| # | 来源 | 版本 / 时间 | 用途 |
|---|------|------------|------|
| 1 | `@jlceda/pro-api-types` 类型定义 (`node_modules/@jlceda/pro-api-types/index.d.ts`, 19437 行) | **0.4.25** | **权威依据**，所有函数签名以此为准 |
| 2 | `easyeda-api-sdk` | **1.6.28** | 构建 / 打包工具链 |
| 3 | 官方文档离线包 `easyeda-api.zip` | 1.0.3 | 辅助说明 |
| 4 | 官方文档站 https://prodocs.easyeda.com/en/api/guide/ | 在线版 | 流程 / 配置说明 |
| 5 | 官方开源示例 `github.com/easyeda/eext-run-api-gateway` | 1.0.6 | 真实工程写法参考 |

> **重要发现**：官方文档离线包（来源 3）**已过期**。它完全没有收录本插件依赖的
> `openReadFolderPathDialog` / `createDirectoryInFileSystem` / `existsPathInFileSystem`
> 等 `SYS_FileSystem` 接口，且 `SYS_MessageBus` 的方法名与当前 SDK 不符
> （文档写 `publish`/`pull`，实际为 `push`/`pushPublic`/`pull`/`subscribe`/`rpcCall`）。
> 因此**全部以来源 1 的类型定义为准**，未凭函数名猜测任何接口。

SDK 要求 Node.js `>= 20.17.0`；本机使用 Node v22.22.2。

---

## 一、制造文件导出 —— `eda.pcb_ManufactureData`

`PCB_ManufactureData`（PCB & 封装 / 生产资料类）。
**全部方法均标注 `@beta`（BETA 预览状态）**，官方明确说明「任何功能都可能在接下来的开发进程中被修改，请不要将它用于任何正式环境」。插件内对每个调用都做了 `try/catch` 与返回值校验。

| 功能 | 函数签名 | Beta | Deprecated |
|------|---------|------|-----------|
| Gerber | `getGerberFile(fileName?, colorSilkscreen?, unit?: ESYS_Unit.MILLIMETER \| ESYS_Unit.INCH, digitalFormat?: { integerNumber: number; decimalNumber: number }, other?: {...}, layers?: Array<{ layerId: EPCB_LayerId; isMirror: boolean }>, objects?: Array<'Pad' \| ... >): Promise<File \| undefined>` | ✅ | ❌ |
| BOM | `getBomFile(fileName?, fileType?: 'xlsx' \| 'csv', template?, filterOptions?: Array<{ property: string; includeValue: boolean \| string }>, statistics?: Array<string>, property?: Array<string>, columns?: Array<IPCB_BomPropertiesTableColumns>): Promise<File \| undefined>` | ✅ | ❌ |
| Pick & Place / CPL | `getPickAndPlaceFile(fileName?, fileType?: 'xlsx' \| 'csv', unit?: ESYS_Unit.MILLIMETER \| ESYS_Unit.MIL): Promise<File \| undefined>` | ✅ | ❌ |
| STEP | `get3DFile(fileName?, fileType?: 'step' \| 'obj', element?: Array<'Component Model' \| 'Via' \| 'Silkscreen' \| 'Wire In Signal Layer'>, modelMode?: 'Outfit' \| 'Parts', autoGenerateModels?: boolean): Promise<File \| undefined>` | ✅ | ❌ |
| 一键制造文件 | `getManufactureData(): Promise<File \| undefined>` | ✅ | ❌ |
| **交互式 BOM** | `getInteractiveBomFile(fileName?): Promise<File \| undefined>` | ⚠️ **`@internal`** | ❌ |

### 关于交互式 BOM（`getInteractiveBomFile`）

该接口在类型定义中标注为 **`@internal`**，与同类的 `@beta` 接口有本质区别：

- **`@beta`** = 公开预览接口，官方会在发布说明中告知变更；
- **`@internal`** = 内部接口，**官方不承诺任何稳定性**，可能在任何版本改名、改签名或移除，且不另行通知。

因此本插件的处理方式（对应任务书「如果某个功能通过公开 API 确实无法实现，请在 UI 中标注，而不是伪造」）：

1. **如实实现** —— 它确实存在于当前 SDK 且返回 `Promise<File | undefined>`，能做到就用，不谎称不支持；
2. **隔离风险** —— 独立 `try/catch`，这一项失败**不影响**任何其它交付文件；
3. **如实标注** —— 在 `Export_Report.txt` 与完成窗口中写明「来源：官方 `getInteractiveBomFile`（标注为 @internal，未来版本可能变更）」；
4. **自检可查** —— 「环境自检」菜单会单独探测该接口是否存在。

> 与之对照：**3D HTML 是真正的「不支持」**（类型定义中完全不存在对应接口，见第八节），
> 两者不可混为一谈 —— 一个是「有接口但不保证稳定」，一个是「根本没接口」。插件对这两种情况的 UI 表现也完全不同。

**决策**：`getGerberFile` / `getBomFile` / `getPickAndPlaceFile` / `get3DFile` 全部**只传文件名与格式**，其余参数留空，让 EasyEDA 使用自身默认配置，从而「保持 EasyEDA 官方生成的内容，不自行重新生成」。

**弃用**：不使用 `getManufactureData()` —— 其 `@remarks` 明确写明「仅私有化部署版本有效，如若在其他版本调用将始终 `throw Error`」。

---

## 二、原理图 PDF —— `eda.sch_ManufactureData`

| 功能 | 函数签名 | Beta | Deprecated |
|------|---------|------|-----------|
| 导出文档（PDF/PNG/SVG） | `getExportDocumentFile(fileName?, fileType?: ESCH_ExportDocumentFileType, typeSpecificParams?: { theme?; lineWidth?; displayAttributesAsMenu?; size?: 'Original Size' \| string \| { width; height; unit } }, object?: 'All Schematic' \| 'Current Schematic' \| 'Current Schematic Page' \| string, objectSpecificParams?: { range?: 'All' \| [number, number]; outputMethod?: 'Merged sheet' \| 'Separated sheet' }): Promise<File \| undefined>` | ❌ | ❌ |
| PNG / SVG | `getPngFile(...)` / `getSvgFile(...)` | ❌ | ❌ |

`enum ESCH_ExportDocumentFileType { PDF = 'PDF', PNG = 'PNG', SVG = 'SVG' }` —— **未弃用**。

**决策**：**不采用**「逐页导出再尝试合并」的方案。直接使用
`object = 'All Schematic'` + `objectSpecificParams.outputMethod = 'Merged sheet'` + `range = 'All'`，
由 EasyEDA 一次性输出**全部原理图页合并后的单个 PDF**。
本类备注为「获取当前原理图图页的生产资料文件」，因此实现中加入了「若当前不在原理图上下文则先打开首个原理图图页、导出后恢复原标签页」的降级重试逻辑。

---

## 三、工程源文件 —— `eda.sys_FileManager`（**注意：不是 `DMT_Project`**）

| 功能 | 函数签名 | 所属类 | Beta | Deprecated |
|------|---------|-------|------|-----------|
| 获取工程文件 | `getProjectFile(fileName?: string, password?: string, fileType?: 'epro' \| 'epro2'): Promise<File \| undefined>` | `SYS_FileManager` | ❌ | ❌ |
| 按 UUID 获取工程文件 | `getProjectFileByProjectUuid(projectUuid, fileName?, password?, fileType?): Promise<File \| undefined>` | `SYS_FileManager` | ✅ | ❌ |

> 提示中提到的 `DMT_Project.getProjectFile()` **不存在**。`DMT_Project` 只有
> `createProject / openProject / getCurrentProjectInfo / getProjectInfo / getAllProjectsUuid / moveProjectToFolder` 六个方法。
> 正确入口是 `eda.sys_FileManager.getProjectFile()`。

**权限**：`@remarks` 明确「本接口需要启用 **工程管理 > 下载工程** 权限，没有权限调用将始终 `throw Error`」。

### V2 / V3 格式对应关系（已核实）

官方 V3 更新日志（http://pro.easyeda.com/page/update-record ）原文：

> New project archive format **epro2** (Top menu - File - Save As - Save Project to Local 稿) … Support exporting **V2.2 format files epro** and elibz

官方论坛回复亦确认：「epro 是 V2 客户端打开的，epro2 是 V3 客户端打开的」。

| 用户选择 | `fileType` 传参 | 输出文件名 |
|---------|----------------|-----------|
| **V3**（默认） | `'epro2'` | `ProjectName.epro2` |
| **V2** | `'epro'` | `ProjectName.epro` |

---

## 四、DRC —— `eda.pcb_Drc`

| 功能 | 函数签名 | Beta | Deprecated |
|------|---------|------|-----------|
| DRC 检查（布尔） | `check(strict: boolean, userInterface: boolean, includeVerboseError: false): Promise<boolean>` | ✅ | ❌ |
| DRC 检查（详细） | `check(strict: boolean, userInterface: boolean, includeVerboseError: true): Promise<Array<any>>` | ✅ | ❌ |

- `strict`：官方备注「当前 PCB 统一为严格检查模式」，固定传 `true`。
- `userInterface`：是否呼出底部 DRC 窗口。
- `includeVerboseError`：为 `true` 时返回值恒为数组。

**重要**：返回值结构为**未公开的 `Array<any>`**，官方**没有**定义 `Errors` / `Unrouted` 字段。
因此 UI 中**没有**硬编码「Errors: n / Unrouted: n」这种假字段，而是实现了一个**防御式分析器**：
遍历数组元素的常见字段名（`severity` / `type` / `level` / `category` / `errorType` / `ruleName` 等）做归类，
无法归类时仅报告**条目总数**，并把原始结果的 JSON（截断）写入 `Export_Report.txt` 供人工核对。

---

## 五、文件系统 / 输出目录 —— `eda.sys_FileSystem`

| 功能 | 函数签名 | 权限要求 | Beta/Alpha | 引入版本 |
|------|---------|---------|-----------|---------|
| **选择输出目录（首选）** | `openReadFolderPathDialog(): Promise<string \| undefined>` | 仅客户端有效（浏览器环境 `throw Error`） | `@alpha` | **无标注** |
| 选择输出目录（次选） | `openReadFilePathDialog(filenameExtensions?: string \| Array<string>, multiFiles?: false): Promise<string \| undefined>` | 同上 | `@alpha` | **无标注** |
| 创建目录（可递归） | `createDirectoryInFileSystem(folderPath: string): Promise<boolean>` | **需要「外部交互」权限** | `@beta` | **ADD since v3.2.166** |
| 判断路径存在 | `existsPathInFileSystem(uri: string): Promise<boolean>` | **需要「外部交互」权限** | `@beta` | **ADD since v3.2.167** |
| 写入文件 | `saveFileToFileSystem(uri, fileData: File \| Blob, fileName?: string, force?: boolean): Promise<boolean>` | **需要「外部交互」权限** | `@beta` | **无标注（早期即存在）** |
| 列目录 | `listFilesOfFileSystem(folderPath: string, recursive?: boolean): Promise<Array<ISYS_FileSystemFileList>>` | **需要「外部交互」权限** | `@beta` | **无标注** |
| 文档目录 | `getDocumentsPath(): Promise<string>` / `getEdaPath(): Promise<string>` | **需要「外部交互」权限** | `@beta` | **无标注** |
| 另存 / 下载 | `saveFile(fileData: File \| Blob, fileName?: string): Promise<void>` | 无 | `@public` | — |

**关键结论**：

1. **不存在** `openReadFolderDialog()` 这个「打开文件夹读取」接口用于选择输出目录；它返回的是
   `Array<{ relativePath, file }>`（把整个文件夹内容读进来），**不适合**作为「选择输出目录」。
   **本插件使用 `openReadFolderPathDialog()`** —— 它直接返回用户选中的**目录路径字符串**，
   且**不受**「外部交互」权限限制（是原生目录选择框）。
2. `createDirectoryInFileSystem` / `saveFileToFileSystem` / `existsPathInFileSystem` **必须**由用户在
   **扩展管理器 → 已安装 → 本扩展 → 启用「外部交互」** 后才能调用，否则**始终 `throw Error`**。
   实现中加入了**前置探测**（`getDocumentsPath()`），失败时给出明确指引而不是让用户看到一堆报错。
3. `saveFileToFileSystem` 的 `uri` 语义：结尾带 `\`（Windows）视为**目录**，此时 `fileName` 生效；
   结尾不带斜杠视为**完整文件路径**，此时 `fileName` 被忽略。本插件直接传**完整文件路径**，避免歧义。
4. 输出路径**不固定到 Downloads**，完全由用户通过目录选择框决定。
5. `force` 参数的官方语义（原文）：**「强制写入（文件存在则覆盖文件）」**，
   返回值为 **「写入操作是否成功，如若不允许覆盖但文件已存在将返回 `false` 的结果」**。
   这条返回值语义是本插件在缺少 `existsPathInFileSystem` 的旧版客户端上
   **判断「目录是否已被历史交付占用」的官方依据**（见第十三节）。
6. `showInputDialog` 的类型定义返回 `void`，但同一条目上的 `@returns` 注释写的是
   「用户输入的值，始终为 `string` 类型，除非用户点击了 **取消** 按钮」——
   **注释与签名不一致**。本插件一律按签名走 `callbackFn` 取值，
   并用 `settled` 标志 + 超时保护避免重复 resolve 或永久挂起。

---

## 六、设置持久化 —— `eda.sys_Storage`

| 功能 | 函数签名 | Beta | Deprecated |
|------|---------|------|-----------|
| 读单键 | `getExtensionUserConfig(key: string): any \| undefined` | ❌ | ❌ |
| 写单键 | `setExtensionUserConfig(key: string, value: any): Promise<boolean>` | ❌ | ❌ |
| 读全部 | `getExtensionAllUserConfigs(): { [key: string]: any }` | ❌ | ❌ |
| 写全部 | `setExtensionAllUserConfigs(configs: { [key: string]: any }): Promise<boolean>` | ❌ | ❌ |

**决策**：使用**单键** `pcb-delivery-export.settings` 存一个 JSON 对象，读写更少、更少出错；
调用 API 侧失败时自动回退到 `localStorage`（仅作容错，不作为主路径）。

---

## 七、UI —— `eda.sys_Dialog`

| 功能 | 函数签名 | 用途 |
|------|---------|------|
| 信息弹窗 | `showInformationMessage(content, title?, buttonTitle?): void` | 完成报告 / 未打开 PCB 提示 |
| 确认弹窗 | `showConfirmationMessage(content, title?, mainButtonTitle?, buttonTitle?, callbackFn?): void` | DRC 未通过时「取消导出 / 仍然导出」 |
| 多选框（checkbox 列表） | `showSelectDialog(options, beforeContent?, afterContent?, title?, defaultOption?: Array<string>, multiple?: true, callbackFn?: (value: Array<string>) => void \| Promise<void>): void` | **本插件的配置界面主控件** |
| 单选 | `showSelectDialog(options, ..., defaultOption?: string, multiple?: false, callbackFn?: (value: string) => void)` | V3/V2 选择、DRC 选项 |
| Toast | `eda.sys_Message.showToastMessage(message, messageType?: ESYS_ToastMessageType, timer?, ...)` | 进度提示 |
| 日志面板 | `eda.sys_Log.add(message, type?: ESYS_LogType)` / `.export()` | 调试日志 |

### 关于 IFrame 自定义 HTML 窗口与 3D HTML 的核实

- `eda.sys_IFrame.openIFrame(htmlFileName, width?, height?, id?, props?): Promise<boolean>` **存在**，可加载扩展包内的自定义 HTML。
- 但官方文档**未公开** IFrame 与主脚本之间受支持的通信方式（既未说明 IFrame 内可直接使用全局 `eda`，
  也未给出 `postMessage` / `SYS_MessageBus` 的官方桥接示例）。`SYS_Dialog.createDesignPortal()` 需要外部依赖
  `lc-editor-design-react`。
- **决策（依据用户要求「UI 不要求复杂或漂亮，优先保证稳定、清晰、实用」）**：配置界面使用官方
  `showSelectDialog(multiple: true)` 呈现**原生 checkbox 列表** + `showInformativeMessage` 呈现报告，
  **不引入**未经验证的 IFrame 通信桥。这样在 Web 版与客户端都不会出现「窗口打开了但数据传不出来」的故障。

### ⚠️ v1.1.0 关键修正：通知必须做成降级链

v1.0.0 把所有用户提示直接写成 `eda.sys_Dialog.showInformationMessage(...)`。
用户反馈「导入后点了，没有任何反映」。复盘发现一个**致命的失败模式**：

```
业务代码 throw
  → 进 try/catch
    → catch 里调用 showInfo() 上报错误
      → 而 sys_Dialog 在该环境下也不可用，showInfo() 同样 throw
        → 异常逃逸成 unhandled rejection
          → 用户看到的就是「什么都没有」
```

**修复**：新增 `src/notify.ts`，把「让用户看到信息」做成一条降级链，
且 `notify()` 本身被设计为**永不抛出**：

| 顺序 | 通道 | 说明 |
|------|------|------|
| 1 | `eda.sys_Dialog.showInformationMessage` | 官方 V3 推荐信息弹窗 |
| 2 | `eda.sys_MessageBox.showInformationMessage` | 旧版同名接口（方法签名一致），作为兼容层 |
| 3 | `eda.sys_Message.showToastMessage` | 轻量 Toast（内容超 800 字自动截断） |
| 4 | 宿主 `window.alert` | 浏览器 / 客户端兜底 |
| 5 | `console` | 最后留痕 |

**另外新增「环境自检」菜单项**（`registerFn: "selfCheck"`）：它保持**同步**、
只做属性存在性探测、不依赖任何业务逻辑，因此可以作为「扩展是否真的被加载并激活」
的可靠探针。它有反应 → 问题在业务流程；它也没反应 → 问题在加载 / 激活环节。

---

## 十一、`extension.json` 字段规范（来自官方文档站 `guide/extension-json`）

| 字段 | 类型 / 约束 | 本插件取值 |
|------|------------|-----------|
| `name` | 仅小写字母 `a-z`、数字 `0-9`、连字符 `-`，长度 **5–30** | `pcb-delivery-export` ✅ |
| `uuid` | 仅小写字母与数字，长度 **32**（SDK 校验正则 `^[a-z0-9]{32}$`） | `b6009d46b28448bd970612c73b90ee04` ✅ |
| `version` | `major.minor.patch` | `1.2.0` |
| `engines.eda` | 适用的 EasyEDA 专业版版本范围 | `>=3.0.0` |
| `categories` | **`string \| Array<string>`**（两种都合法） | `["PCB"]` ✅ |
| `activationEvents` | 官方标注 `feature in working`（尚未实现），模板取 `{}` | `{}` |
| `entry` | 入口文件，官方建议不要修改 | `./dist/index` |
| `headerMenus` | 按编辑器环境分组的菜单数组 | 仅 `pcb`（PCB 编辑器） |
| `headerMenus[].id` | 菜单 ID，**必须唯一** | `pcb-delivery` |
| `headerMenus[].menuItems[]` | 子项，**最多嵌套两层** | 3 项，一层 |
| `menuItems` vs `registerFn` | **同一层级二者互斥**，不能同时存在 | 分组层用 `menuItems`，子项层用 `registerFn` ✅ |

**编辑器环境键名**（`ESYS_HeaderMenuEnvironment`）：
`home` / `blank` / `sch`（已弃用，改用 `schematic`）/ `symbol` / `pcb` / `footprint` /
`pcbView` / `panel` / `panelLibrary` / `panelView` / `simulationSchematicNgspice` /
`simulationSchematicSimulIDE`。

> 注意 `ESYS_HeaderMenuEnvironment.SCHEMATIC` 的枚举**值**仍是 `'sch'`，
> 而接口 `ISYS_HeaderMenus` 中 `sch` 已标注 `@deprecated`、推荐 `schematic` —— 两者不一致，属官方遗留。
> 本插件只使用 `pcb`，不受影响。

**`registerFn` 的注册机制**：`headerMenus` 中 `registerFn` 填写的方法名，
必须在扩展入口文件里用 ES Module `export` 导出。esbuild 以 `format: 'iife'` +
`globalName: 'edaEsbuildExportName'` 打包，因此最终形如
`edaEsbuildExportName.exportDeliveryPackage`。本插件已用运行时仿真验证导出表为
`['activate', 'exportDeliveryPackage', 'selfCheck', 'liveApiTest']`。

---

## 十二、v1.2.0 全量 API 存在性核验

用脚本解析 `index.d.ts`，逐个提取每个 API 类的公开方法清单，再与插件**实际调用**的方法比对
（`python tools/check-api.py`）：

```
存在 32 项 / 缺失 0 项
```

核验覆盖：`SYS_Dialog`(4) `SYS_MessageBox`(1) `SYS_Message`(1) `SYS_Environment`(2)
`SYS_Storage`(2) `SYS_FileSystem`(7) `SYS_FileManager`(1) `SYS_Log`(1) `SYS_I18n`(1)
`DMT_Project`(1) `DMT_SelectControl`(1) `DMT_EditorControl`(2) `DMT_Schematic`(1)
`PCB_ManufactureData`(5) `SCH_ManufactureData`(1) `PCB_Drc`(1)。

> v1.2.0 相比 v1.1.0 新增核验：`showInputDialog`、`openReadFilePathDialog`、
> `listFilesOfFileSystem`、`SYS_MessageBox.showInformationMessage`。
> 注意这些方法与「37 项能力清单」不是一回事：能力清单额外包含只做**探测**、
> 当前不会真正调用的接口（如 `readFileFromFileSystem`、`deleteFileInFileSystem`、
> `getEdaPath`、`openReadFolderDialog` 等）。
>
> ⚠️ **「存在 32 项」只说明这些方法在最新的类型定义里存在，不代表在用户机器上都可用** ——
> 用户实测的 3.2.149 客户端就缺了其中 3 个。因此运行时探测（第十三节）是必需的。

**排除的误用**：`SYS_ToastMessage` 的方法名是 `showMessage` 而**不是** `showToastMessage`；
后者位于 `SYS_Message`。插件使用的是 `eda.sys_Message.showToastMessage`（已核实存在）。

---

## 八、3D HTML —— ❌ **当前官方 API 不支持**

对 `index.d.ts`（19437 行）做了全量检索：

| 检索项 | 结果 |
|--------|------|
| 含 `html` 且与 file/export/3d 相关的 API | **0 个** |
| `get3DFile` 支持的 `fileType` | `'step' \| 'obj'` —— **无 `html`** |
| `get3DShellFile` 支持的 `fileType` | `'stl' \| 'step' \| 'obj'` —— **无 `html`** |
| `pcb_ManufactureData` 全量方法（27 个） | 无 3D HTML 导出 |
| `sch_ManufactureData` 全量方法 | 无 3D HTML 导出 |
| 唯一含 `html` 的接口 | `SYS_IFrame.openIFrame()` —— 这是**加载**扩展自带 HTML 到内联框架，**不是**导出 3D 模型为 HTML |

**结论**：`ProjectName_3D.html` **无法实现**。按用户要求：

- UI 中该选项显示为 `3D HTML (Current EasyEDA API does not support this export)`；
- 该选项**不可勾选（禁用）**；
- **不模拟鼠标点击、不伪造 HTML**；
- 预留了 `reserved3DHtml` 代码路径与开关位，官方 API 支持后可直接接入。

---

## 九、`eda` 全局对象的真实访问器（已逐个核实）

```
eda.pcb_ManufactureData     eda.sch_ManufactureData    eda.sys_FileManager
eda.sys_FileSystem          eda.sys_Storage            eda.sys_Dialog
eda.sys_Message             eda.sys_Log                eda.sys_I18n
eda.sys_IFrame              eda.sys_Environment        eda.pcb_Drc
eda.dmt_Project             eda.dmt_SelectControl      eda.dmt_EditorControl
eda.dmt_Pcb                 eda.dmt_Schematic
```

## 十、⚠️ 运行时陷阱：`@jlceda/pro-api-types` 是**纯类型包**

`index.d.ts` 结尾为 `export {}`，全部内容位于 `declare global { ... }` 中，
**不包含任何运行时代码**。因此：

```ts
// ❌ 运行时崩溃：ESYS_Unit is not defined
await eda.pcb_ManufactureData.getPickAndPlaceFile(name, 'xlsx', ESYS_Unit.MILLIMETER);

// ✅ 本插件的写法：字面量 + 类型断言，类型安全且运行时不依赖枚举对象
const UNIT_MM = 'mm' as ESYS_Unit.MILLIMETER;
await eda.pcb_ManufactureData.getPickAndPlaceFile(name, 'xlsx', UNIT_MM);
```

同理 `EDMT_EditorDocumentType.PCB === 3`，代码中使用字面量 `3` 并断言为
`EDMT_EditorDocumentType.PCB`。所有枚举一律按此规则处理，已在 `src/edaCompat.ts` 集中定义。

---

## 十三、v1.2.0 关键发现 —— 只能运行时探测，不能按版本号判断

### 13.1 触发事件（真机证据）

用户在自己机器上运行 v1.1.0 的「环境自检」，得到：

```
插件版本 / Plugin Version: 1.1.0
EasyEDA 版本 / Version : 3.2.149.88089769
运行环境 / Runtime : 客户端 / Desktop client

[本地文件系统]
  OK  sys_FileSystem.getDocumentsPath
  MISS sys_FileSystem.createDirectoryInFileSystem
  OK  sys_FileSystem.saveFileToFileSystem
  MISS sys_FileSystem.existsPathInFileSystem
  MISS sys_FileSystem.openReadFolderPathDialog

API 探测结果 / Result: 20 / 23 可用
⚠ 其中包含核心 API，本插件在当前版本上无法正常工作。
```

同时现象是：**点「一键导出」没有任何反应**。

### 13.2 `ADD since EDA vX` 标注**不是**存在性预言机

类型定义里的 `ADD since EDA vX` 是**写在某一条重载声明**上的注释，含义是
「这条重载从 vX 开始加入」，**不等于**「这个名字首次出现在 vX」。反例是硬证据：

| 接口 | `ADD since` 标注 | 在 EDA 3.2.149 上的实测 | 结论 |
|------|-----------------|----------------------|------|
| `sys_Environment.getEditorCurrentVersion` | **v3.2.176** | ✅ **已可用** | 标注 ≠ 引入版本 |
| `sys_FileSystem.createDirectoryInFileSystem` | v3.2.166 | ❌ 不存在 | 标注可作为**下界参考** |
| `sys_FileSystem.existsPathInFileSystem` | v3.2.167 | ❌ 不存在 | 同上 |
| `sys_FileSystem.openReadFolderPathDialog` | **无标注** | ❌ 不存在 | **无标注者完全无法预判** |

此外，`@jlceda/pro-api-types@0.4.25` 描述的是覆盖到 **EDA v4.1.13** 的接口面，
比用户的 3.2.149 客户端超前一年多。**静态类型检查通过 ≠ 运行时可调用。**

### 13.3 因此确立的规则

> **规则：只做运行时能力探测，绝不按版本号做静态能力判断。**

落地为 `src/capabilities.ts` —— 本插件所有接口的**唯一事实源**：

- 37 个 `访问器.方法` 键，每个带 `group` / `critical` / `fallback` / `since`（仅在有标注时）；
- `critical: true` 的定义是「**没有任何替代路径**」。当前共 5 项：
  `saveFileToFileSystem`（唯一的本地写入通道）、`showSelectDialog`（唯一的配置窗口）、
  以及必选的三件套 `getGerberFile` / `getBomFile` / `getPickAndPlaceFile`。
  **反例说明**：`existsPathInFileSystem` 看起来同样核心，但它有三级降级（见 13.4），
  因此标记为**非核心** —— `critical` 判的是「有没有替代路径」，不是「重不重要」；
- `probeKey()` 逐段遍历 `eda → 访问器 → 方法`，**中间层同时接受 `object` 与 `function`**
  （命名空间本身可能是可调用对象），任一段缺失即收敛为 `false`，永不抛出；
- 结果缓存，`invalidateCapabilities()` 供测试重置；
- `missingCriticalCapabilities()` 是流程入口的「能不能干活」判据。

配套地，「环境自检」菜单现在直接消费 `CAPABILITY_META`，打印每个缺失项的
`[核心]` / `[v3.2.166]` 标记与「已自动降级：…」说明，不会再出现
「只报 MISS、不说怎么办」的半截信息。

### 13.4 写入探测（write-probe）—— 用 `force = false` 判断目录占用

用户机器上没有 `existsPathInFileSystem`，但**有** `saveFileToFileSystem`。
依据 13.1 引用的官方 `force` 语义（「如若不允许覆盖但文件已存在将返回 `false`」），
可以把「这个交付目录名是否已被历史交付占用」转化为一次**不产生副作用**的写入尝试：

```ts
// 探测：force 必须为 false，否则就真的把探测文件写进去了
const ok = await eda.sys_FileSystem.saveFileToFileSystem(
	`${dir}${SEP}Export_Report.txt`,
	probeBlob,
	undefined,
	false,
);
// ok === false  → 该目录里已有 Export_Report.txt → 说明历史目录已占用 → 换 _02
// ok === true   → 目录是新的（或被隐式创建）：继续
```

两个设计要点：

1. **探测文件复用 `Export_Report.txt`** —— 它是交付目录中**必然存在**的文件，
   导出成功时会被完整报告覆盖，因此**不会在用户目录里留下任何多余文件**；
2. **探测同时验证了「目录可写」** —— 一次调用同时回答「占用了吗」和「写得进去吗」，
   在不支持 `createDirectoryInFileSystem` 的版本上，这也是**唯一**能确认
   `saveFileToFileSystem` 会隐式创建父目录的方法。

三级占用判定策略（策略名会写入 `Export_Report.txt` 的 `ENVIRONMENT` 段）：

| 策略名 | 依赖 | 触发条件 |
|--------|------|---------|
| `exist-check` | `existsPathInFileSystem` | 存在该接口 |
| `list-check` | `listFilesOfFileSystem` | 无前者，但有列目录能力 |
| `write-probe` | `saveFileToFileSystem` | 前两者都没有 |

### 13.5 四级输出目录解析

`openReadFolderPathDialog` 在 3.2.149 上同样缺失，因此目录选择也做成降级链：

| 级别 | 接口 | 用户动作 | 记录到报告的 `dirSource` |
|------|------|---------|----------------------|
| 1 | `openReadFolderPathDialog` | 选一个文件夹 | `openReadFolderPathDialog` |
| 2 | `openReadFilePathDialog` → `dirnameOf()` | 选任意文件，取其所在目录 | `openReadFilePathDialog(dirname)` |
| 3 | `sys_Dialog.showInputDialog` | 手填 / 粘贴绝对路径（已预填默认值） | `showInputDialog(manual)` |
| 4 | `getDocumentsPath()` + `/PCB_Delivery` | 无需动作 | `fallback(Documents/PCB_Delivery)` |

另外两个取值：沿用上次目录记 `remembered(previous)`；用户在选择框里取消且已有历史目录时记
`cancelled(keep previous)`。

`attempt()` 把两种「没拿到值」严格区分开：

- `ok: false` → **接口不可用**（不存在 / 抛异常 / 超时）→ 继续往下一级降；
- `ok: true` + `value === undefined` → **用户主动取消** → **保留原目录**，不擅自改到兜底目录。

### 13.6 「点了没反应」的第三个根因：`await` 卡在弹窗之前

v1.1.0 的 `exportDeliveryPackage` 是 `async` 的，在弹出配置窗口**之前**先 `await` 了
两个官方查询接口：

```ts
// ❌ v1.1.0：接口「存在但永不返回」时，用户连窗口都看不到
const pcbOpen = await isPcbDocumentOpen(); // 可能永不 settle
const envIssue = await checkRuntimeEnvironment(); // 可能永不 settle
startConfigFlow(settings, /* … */); // ← 永远走不到
```

**`try/catch` 抓不住挂起**——这不是异常，是永不 settle 的 Promise。
因此 v1.2.0 引入三件工具（`src/edaCompat.ts`）：

| 工具 | 语义 |
|------|------|
| `withTimeout(promise, ms, label)` | `Promise.race` + `setTimeout`；超时抛 `ApiTimeoutError`（带 label 与 ms） |
| `softCall(label, ms, fn, fallback)` | **永不抛出**；超时 / 异常一律返回 `fallback` |
| `attempt(label, ms, fn)` | 返回 `{ ok, value? }`，用于区分「不可用」与「用户取消」 |

并且入口改为：**已知的前置检查一律「超时即通过」**——宁可让后续步骤给出具体错误，
也绝不把用户挡在看不见的门外面。同时 `exportDeliveryPackage` 变为**同步**函数：

```ts
export function exportDeliveryPackage(): void {
	void runEntry();
}
```

超时常量：元数据查询 5 s（`METADATA_TIMEOUT_MS`）、能力探测 20 s（`PROBE_TIMEOUT_MS`）、
交付文件写入 5 min（`DELIVERABLE_WRITE_TIMEOUT_MS`）、
目录 / 文件选择与输入框 5 min（`PICKER_TIMEOUT_MS`，等待用户操作，必须给足）。

### 13.7 第三个菜单项：`liveApiTest`（接口连通性实测）

「环境自检」只读属性，**证明不了「能调用」**。因此新增 `registerFn: "liveApiTest"`，
真的调用一次接口并记录耗时，状态取值：

| 状态 | 含义 |
|------|------|
| `OK` | 正常返回（打印耗时 ms） |
| `MISS` | 属性不存在 |
| `TIMEOUT` | **存在但永不返回** —— 这正是「点击无反应」的特征签名 |
| `ERROR` | 调用抛异常（打印错误信息） |
| `SKIP` | 只读、无副作用地调用不了，跳过 |

**只调用只读接口**，绝不调 `showXxxDialog` 之类会弹窗的接口，避免用户点一下菜单就被弹窗糊脸。
报告末尾会给出结论段：无异常时明确写出「所有被实测的接口都在超时上限内正常返回」；
出现 `TIMEOUT` 时逐条列出接口名，并解释这正是「点击菜单后毫无反应」的成因形态、
以及 v1.2.0 起已用硬超时规避。

---

## 十四、v1.3.0 关键发现 —— 「信息条不消失」与「已连续尝试 20 次」

### 14.1 `showToastMessage` 的 `timer` 单位是「秒」，不是毫秒

用户反馈：**「而且这几个信息条一直不消失」**。

官方签名与注释（`@jlceda/pro-api-types`，`class SYS_Message`）：

```ts
// @jlceda/pro-api-types —— class SYS_Message（节选）
class SYS_Message {
	// @param timer - 自动关闭倒计时秒数，`0` 为不自动关闭
	showToastMessage(
		message: string,
		messageType?: ESYS_ToastMessageType,
		timer?: number,
		bottomPanel?: ESYS_BottomPanelTab,
		buttonTitle?: string,
		buttonCallbackFn?: string,
	): void;
}
```

v1.2.0 及之前按「毫秒」的直觉传了 `8000` / `6000` / `3000`，
实际效果是让 Toast 挂 **8000 秒 = 2 小时 13 分**、**3000 秒 = 50 分钟** 才自动关闭。
叠加多个进度 Toast 后，用户看到的就是「一排信息条永远停在那里」。

**规则**：Toast 时长一律取自 `edaCompat.ts` 的 `TOAST_SEC_*` 常量（命名里写明单位），
禁止直接写字面量；并有测试断言传给官方的 `timer` 落在 `1 … 60` 秒区间。

| 常量 | 值 | 用途 |
|------|-----|------|
| `TOAST_SEC_PROGRESS` | 3 | 进度提示（正在导出 X…） |
| `TOAST_SEC_BRIEF` | 6 | 常规提示 |
| `TOAST_SEC_STICKY` | 15 | 错误 / 警告，需留够阅读时间 |

### 14.2 `force = false` 返回 `false` 有**两种**含义，混为一谈就是「已连续尝试 20 次」

用户反馈原文：

```
ExportStepError: 无法写入输出目录（已连续尝试 20 次）：
E:/work/fiverr/260922_aguepe6_POE传感器/输出
```

旧实现的推理链是：`force=false` 返回 `false` ⇒ 文件已存在 ⇒ 目录被历史交付占用 ⇒ 换下一个 `_02` 槽位。
但返回值语义还有**第二种**可能：**这个目录根本写不进去**（父目录不存在 / 路径不可写 / 非 ASCII 路径）。
第二种情况下换 20 个槽位只会得到 20 次相同的失败 —— 这正是「已连续尝试 20 次」的来源。

**因此 `ProbeResult` 必须把结果分成四类**，处理策略各不相同：

| outcome | 含义 | 处理 |
|---------|------|------|
| `writable` | 写进去了 | 采用该目录 |
| `occupied` | 返回 `false`，且**已确认**该槽位是空的仍写不进 | 停止换槽位（环境问题） |
| `timeout` | 接口超时未返回 | **立即放弃，绝不重试** |
| `error` | 抛异常 | 有限次数后放弃 |

边界值：`MAX_PROBE_TIMEOUTS = 1`（超时一次即放弃）、`MAX_PROBE_FAILURES_BLIND = 3`
（旧值 20 就是那条报错里的数字）。

### 14.3 判定顺序必须是「先写一次，失败后再归因」

v1.3.0 第一版把「子目录没被创建」的判定放在**写入之前**：

```ts
// ❌ 错误
if (!canCreate && canList) {
	const created = await directoryExists(fullPath);
	if (created === false) {
		blockedPath = fullPath; // 还没试写就放弃
		break;
	}
}
```

这是错的：很多客户端的 `saveFileToFileSystem` **会隐式创建父目录**，
那样一来本可以正常导出的机器也被误判、白白降级。回归测试「场景 2b」直接抓到了这个问题。

正确顺序：**先真实写一次**；写失败了，再去查「子目录到底有没有被建出来」，
确认没建出来才认定「日期子目录这条路走不通」。

### 14.4 两级降级：平铺输出 → 救援目录

即便确认子目录建不出来，也不该让用户一无所获。v1.3.0 新增两级兜底：

| 级别 | 触发条件 | 行为 | 用户可见性 |
|------|---------|------|-----------|
| **平铺输出** | 日期子目录建不出来，但**所选目录本身可写** | 文件直接写进所选目录，文件名前缀为 `工程名_YYYYMMDD` | 完成窗口顶部「请注意」+ 报告 |
| **救援目录** | 所选目录**整体**不可写（典型：路径含中文，个别旧版客户端在此类路径上写入失败） | 改写到 `getDocumentsPath()` / `getEdaPath()`（通常纯 ASCII），前缀同上 | 完成窗口顶部「请注意」+ 报告 |

之所以必须**显示在完成窗口顶部**（而不是只写进报告）：
用户若按原路径去找文件必然找不到，而窗口上却写着「导出成功」——那是最糟糕的结果。
实现上是给 `ExportRunResult` 加了 `criticalNotes: string[]`（区别于只计数的 `warnings`）。

### 14.5 写入探测必须显式传 `fileName`

```ts
// ❌ 探测与实际写入形态不一致 —— 探测通过不代表真能写进去
saveFileToFileSystem(probePath, blob, undefined, force);
// ✅ 与 writeFileToDir 保持一致
saveFileToFileSystem(probePath, blob, fileName, force);
```

### 14.6 `liveApiTest` 新增「写入通道实测」

「无法写入输出目录」至少有三种成因，旧版提示无法区分，等于让用户自己猜：

| 成因 | 处理 |
|------|------|
| 写入接口根本不工作 / 挂起 | 换任何目录都没用，需查权限或重启客户端 |
| 所选目录可写，但**不会隐式创建父目录** | 平铺输出即可解决（插件已自动处理） |
| 只在某个具体路径上失败（如非 ASCII） | 换一个纯英文目录 |

因此实测菜单在**已配置输出目录**时会追加两个真实写入：

- `WRITE-A` 写入**所选目录**；
- `WRITE-B` 写入所选目录下**一个尚不存在的子目录**；
- `WRITE-C` 清理（用 `deleteFileInFileSystem` 删除探测文件与临时目录）。

判据：A 成功 + B 失败 ⇒ 成因 2（报告会直接写出「插件会自动降级为平铺输出」）；
A 也失败 ⇒ 成因 1 或 3（报告指向换目录 / 查权限）。
未配置输出目录时整段 `SKIP`，不往用户磁盘乱写。

---

## 十五、v1.4.0 关键发现 —— fileName 挂起、sys_IFrame 自定义窗口与设置持久化

### 15.1 `saveFileToFileSystem` 传显式 `fileName` 在 3.2.149 上会**永久挂起**

官方签名备注（`class SYS_FileSystem`）：

> 如若结尾为斜杠（Windows 为反斜杠 `\`），则识别为文件夹；
> **如若结尾非斜杠，则识别为完整文件名，此时 `fileName` 参数将被忽略**

即 `fileName` 与「uri 是完整文件路径」**语义重复**。而同一台机器（EasyEDA 3.2.149）实测：

| 调用形态 | 行为 |
|----------|------|
| `saveFileToFileSystem(path, blob, undefined, force)` | **秒回**（v1.2.0 探测，连续 20 次立即返回 false） |
| `saveFileToFileSystem(path, blob, 'Export_Report.txt', force)` | 同样的路径上**10 秒超时无响应**（v1.3.0 探测） |

结论：**凡 uri 已是完整文件路径时，`fileName` 一律传 `undefined`**——
既是官方语义所允许的，也是唯一被证实「有响应」的调用形态。
`probeWritable` 与 `writeFileToDir` 均已按此修正，并有注释锁定。

### 15.2 `sys_IFrame.openIFrame`：官方支持的完全自定义窗口

官方文档（prodocs.lceda.cn「内联框架支持」）明确：

- 扩展包内 `/iframe/` 目录的 HTML 可被 `sys_IFrame.openIFrame('/iframe/config.html', w, h, id, props)` 加载为 Dialog 窗口；
- **IFrame 内可直接访问全局 `eda`**（不是 `window.parent.eda`）；
- 主脚本与 IFrame 是隔离上下文，官方推荐的通信方式就是 **`sys_Storage` 作为桥**。

v1.4.0 用它实现了用户明确要求的配置界面：
复选框**平铺**（`showSelectDialog(multiple)` 在 3.2.149 上渲染为可折叠下拉，不满足要求）、
输出目录行 + **浏览按钮**（原生 `openReadFolderPathDialog` 优先，缺失时用 `listFilesOfFileSystem` 在页面内逐级浏览）。

通信协议（`/iframe/config.html` 头部注释与 `src/ui.ts` 的 `openConfigIframe` 配对）：

| 键 | 方向 | 内容 |
|----|------|------|
| `delivery-ui-request` | 主脚本 → 窗口 | 设置快照 + 能力标记 + 窗口 ID |
| `delivery-ui-alive` | 窗口 → 主脚本 | 加载完成心跳（区分「窗口死了」与「用户取消」） |
| `delivery-ui-result` | 窗口 → 主脚本 | 「开始导出」后的配置结果；写完自关 |

窗口打不开 / 无心跳 / 桥不通 ⇒ 自动回退官方弹窗链；用户点 ✕ ⇒ 视为取消导出。

### 15.3 设置持久化：必须存 **JSON 字符串**并**读回校验**

用户反馈「选项没有保存」。两个叠加成因：

1. 主扩展进程里**没有 `localStorage`**（官方文档明确其只在 sys_IFrame 内可用），
   旧实现的「localStorage 兜底」在主进程里是空操作；
2. `setExtensionUserConfig(key, value: any)` 虽声明接受任意值，
   但对象值在部分客户端上行为不稳。

修复：一律存 `JSON.stringify` 后的字符串（读取侧兼容对象旧格式），
写后**立即读回比对**，不一致按失败处理并写日志。
「接口连通性实测」新增 `sys_Storage 写→读回校验` 一项（独立探针键，不动用户设置），
让用户能一键验证自己的客户端能否记住设置。

---

## 十六、v1.5.0 关键发现 —— 「无法写入扩展存储」是判据写错，不是接口坏了

用户反馈（v1.4.0 装上后）：

> 无法写入扩展存储（sys_Storage），主脚本无法收到本窗口的结果。请关闭本窗口，
> 插件会自动改用传统弹窗。**关闭重开还是这样。点浏览和导出无反应。**

这四条现象其实是**一个根因 + 三个放大项**，全部与官方接口无关 —— 是我们自己判据写错。

### 16.1 ❌ `setExtensionUserConfig(...) === true` 永远为假

官方签名（`class SYS_Storage`）：

```ts
class SYS_Storage {
	// @returns Promise<boolean>
	setExtensionUserConfig(key: string, value: any): Promise<boolean>;
	getExtensionUserConfig(key: string): Promise<any>;
}
```

返回的是 **`Promise<boolean>`**。而 v1.4.0 的 `config.html` 里写的是：

```ts
// ❌ 错误：Promise 永远不 === true
if (!eda.sys_Storage.setExtensionUserConfig(k, v) === true) { /* 判定写入失败 */ }
```

一个 Promise 对象**永不 `=== true`**，于是**每一台机器**都会走到「写入失败」分支：
窗口一打开就报「无法写入扩展存储」，并把「浏览」「开始导出」两个按钮 `disabled` 掉 ——
这就是「点浏览和导出无反应」。

更麻烦的是不同客户端的实际返回形态并不统一，实测与官方类型出现过三种：

| 实现 | 返回 |
|------|------|
| 官方类型声明 | `Promise<boolean>` |
| 部分客户端 | 同步 `boolean` |
| 部分客户端 | `undefined`（写了但不回报） |

**唯一可靠判据是「写后读回一致」**：写完立刻 `getExtensionUserConfig(key)`，
与写入值比对，一致才算成功。返回值一律忽略。
`src/settings.ts` 的 `writeJsonConfigVerified()` 与 `iframe/config.html` 的 `storeSet()` 都按此实现，
并有 `iframe.test.mjs` 场景 5 做静态回归（禁止再出现 `=== true` 形式的判定）。

### 16.2 目录浏览：3.2.149 上「原生目录选择框」与「列目录」都不可用

用户机器的实测结果（v1.4.0 环境自检 34/38，4 项 MISS + 2 项 TIMEOUT）：

| 接口 | 结果 |
|------|------|
| `openReadFolderPathDialog` | **MISS**（不存在） |
| `openReadFilePathDialog` | **MISS** |
| `createDirectoryInFileSystem` | **MISS** |
| `existsPathInFileSystem` | **MISS** |
| `getDocumentsPath()` | **TIMEOUT 5001 ms** |
| `listFilesOfFileSystem('C:////')` | **TIMEOUT 5001 ms** |

即 v1.4.0 设计里「原生目录选择框优先、页面内列目录兜底」的**两条路都是死的**，
所以「浏览」点下去必然没反应。

v1.5.0 把浏览链扩到五档，前四档全部是**该机器上实测存在**的接口：

1. `openReadFolderPathDialog`（新客户端的原生目录选择框，最理想）
2. `openReadFolderDialog` → 从返回的 `File.path` **反推所在目录**（3.2.149 上存在）
3. `openReadFileDialog` → 让用户随便选一个文件，取其所在目录（同上）
4. `listFilesOfFileSystem` 页面内逐级浏览（列目录能用时才用；超时即放弃，**不重试**）
5. 手动输入（最后兜底）

第 2 档是关键：它返回的是「文件」而不是「文件夹」，但 `File.path` 里有完整路径，
`dirnameOf()` 取到目录即可 —— 用户仍然是「点浏览 → 选一个位置」的体验。
`iframe.test.mjs` 场景 3 / 4 分别覆盖第 2、3 档。

### 16.3 「关闭重开还是这样」—— 失败必须被记住，且按客户端版本记忆

v1.4.0 里窗口打不开只是当次回退，下一次点菜单**又弹同一个打不通的窗口**，
用户看到的就是「关闭重开还是这样」。

修复：**写粘性标记** `delivery-ui-broken = { version, at }`，
同一客户端版本下不再尝试 IFrame，直接走官方弹窗链；
`getEditorCurrentVersion()` 结果变化（升级客户端）时重试一次。
版本取不到（空串）时**不视为匹配** —— 避免因一次取版本失败就永久禁用自定义窗口。

### 16.4 主脚本传给窗口的必须是「选项键」数组，不是 `DeliverySettings`

勾选状态看起来「没保存」的另一个成因是**键名不匹配**：

- `DeliverySettings` 的键：`cplFilterEnabled` / `exportSchematicPdf` / `exportInteractiveBom` …
- 选项列表 `OPTION_KEYS` 的键：`cplFilter` / `schematicPdf` / `interactiveBom` …

主脚本传了前者，页面按后者读取 ⇒ 永远读到「未勾选」，显示默认值。
现在主脚本额外传 `selected: currentSelection(settings)`（选项键数组）与 `outputDir`，
页面只认 `selected`。`iframe.test.mjs` 场景 1 / 2 断言回传结果携带真实勾选。

### 16.5 `softCall` 是 async —— 漏一个 `await` 就会拿到 Promise

`currentEdaVersion()` 第一版写成：

```ts
const raw = softCall('sys_Environment.getEditorCurrentVersion', FS_TIMEOUT_MS, fn, '');
// ❌ 上面拿到的是 Promise<string>，不是 string —— 漏了 await
return typeof raw === 'string' ? raw : '';
```

`Promise` 不是 `string`，于是版本永远是空串 ⇒ 粘性标记里存的是 `""` ⇒
「记住失败」形同虚设。TS 的 `tsc --noEmit` 直接抓到了这处
（`This comparison appears to be unintentional ... 'string' and 'Promise<string>'`）。

**规则**：凡经过 `softCall` / `withTimeout` / `attempt` 的值，一律 `await` 后再用；
让整条调用链（`isIframeBroken` / `markIframeBroken`）都是 `async`，不要为了「同步好用」把 Promise 往下传。

### 16.6 页面必须只在**真的**失败时报错

v1.4.0 的报错文案「无法写入扩展存储」会在**每台机器**上出现，
属于典型的「把内部判据错误当成外部环境错误」—— 用户据此去查权限、重启软件，全是无效操作。

v1.5.0 的规则：页面显示的错误必须是**真实可观察的失败**（写后读回不一致、
接口抛异常、接口超时），并写明**接下来会发生什么**（例如「将改用官方弹窗」）；
判据本身的问题只能在日志里，不能当成用户错误弹出来。

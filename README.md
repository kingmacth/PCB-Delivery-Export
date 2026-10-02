# PCB Delivery Export

[简体中文](./README.md) | [English](./README.en.md)

适用于 EasyEDA Pro 的 PCB 交付文件一键导出扩展。

## 功能

Gerber、BOM 和坐标文件（CPL / Pick & Place）为默认必选项。还可以自由组合导出：

- 原理图 PDF
- STEP 3D 模型
- 交互式 BOM（HTML）
- EasyEDA 工程源文件 V3（`.epro2`）或 V2（`.epro`）
- 导出前 DRC 检查

插件可以按照 BOM 自动过滤坐标文件，移除 BOM 中不存在、实际不贴装的元件，减少交付制造时出现“坐标文件元件缺少 BOM 数据”等提示。所有结果会汇总到同一交付目录，并生成 `Export_Report.txt`，方便直接发送给客户或制造商。

导出目录和文件名使用**当前板名**，因此同一个项目内包含多块 PCB 时不会再混用项目名。

导出前还可以设置制造要求：板厚（默认 1.6 mm）、阻焊颜色（默认绿色）、字符颜色（默认白色）、表面处理（默认无铅喷锡）、阻抗控制和自定义备注。扩展会生成两份内容相同的中英双语提醒文件：

- `00_制造要求_请先阅读.txt`
- `00_FABRICATION_REQUIREMENTS_READ_FIRST.txt`

这两份文件也会放入 Gerber ZIP，并将相同信息写进 `Export_Report.txt`。它们用于交付提醒，不会修改 Gerber 或自动填写嘉立创订单；投产前仍须在下单页面逐项确认。

## 使用方法

1. 在 EasyEDA Pro 的扩展管理器中导入 `.eext` 安装包。
2. 为扩展启用“外部交互”和“显示在顶部菜单”，然后重启 EasyEDA Pro。
3. 打开需要导出的 PCB。
4. 选择 **PCB 交付 → 一键导出**。
5. 填写输出目录、选择需要的组合，然后开始导出。

如需英文交互式 BOM，请先将 EasyEDA 的界面语言切换为 English。

### EasyEDA Pro 3.2.149 兼容说明

该版本没有文件夹路径选择和目录创建接口，因此扩展会隐藏无效的“浏览”按钮，要求手动粘贴现有目录的绝对路径，并将带有板名和日期前缀的文件安全地平铺到该目录。新版本客户端支持相关接口时，会创建 `板名_YYYYMMDD` 交付目录。

## 构建

```shell
npm install
npm run lint
npm run compile
npm run test:all
npm run build
```

安装包生成在 `build/dist/`。

## 作者

- kingmacth
- kingmacth@gmail.com

## 开源协议

本项目使用 [Apache License 2.0](./LICENSE)。

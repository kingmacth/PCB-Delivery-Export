# PCB Delivery Export

[简体中文](./README.md) | [English](./README.en.md)

An EasyEDA Pro extension for exporting PCB manufacturing and customer-delivery files in one operation.

## Features

Gerber, BOM, and Pick & Place (CPL) are always exported. Optional outputs can be combined freely:

- Schematic PDF
- STEP 3D model
- Interactive BOM (HTML)
- EasyEDA Project V3 (`.epro2`) or V2 (`.epro`)
- DRC check before export

The extension can filter the Pick & Place file against the BOM and remove unmounted components that are absent from the BOM. This helps avoid manufacturing warnings about CPL components without matching BOM entries. Results are collected as a delivery package with an `Export_Report.txt`, ready to send to a customer or manufacturer.

Output folders and filenames use the **current board name**, so multiple boards in one project receive distinct delivery files.

Fabrication requirements can also be configured before export: board thickness (default 1.6 mm), solder-mask color (default green), silkscreen color (default white), surface finish (default lead-free HASL), impedance control, and custom notes. Two files with identical bilingual content are generated:

- `00_制造要求_请先阅读.txt`
- `00_FABRICATION_REQUIREMENTS_READ_FIRST.txt`

Both files are also embedded in the Gerber ZIP, and the same information is recorded in `Export_Report.txt`. These are delivery reminders; they do not modify Gerber data or fill the JLCPCB order automatically. Verify every option on the order page before fabrication.

## Usage

1. Import the `.eext` package in the EasyEDA Pro Extension Manager.
2. Enable **External Interaction** and **Show in top menu**, then restart EasyEDA Pro.
3. Open the PCB to export.
4. Choose **PCB Delivery → Export Delivery Package**.
5. Enter an output folder, select the required combination, and start the export.

To export an English interactive BOM, switch the EasyEDA UI language to English before exporting.

### EasyEDA Pro 3.2.149 compatibility

This version does not provide folder-path selection or directory-creation APIs. The extension therefore hides the unavailable Browse button, asks for an existing absolute path, and safely writes files with a board-and-date prefix directly into that folder. Newer clients create a `BoardName_YYYYMMDD` delivery folder when the required APIs are available.

## Build

```shell
npm install
npm run lint
npm run compile
npm run test:all
npm run build
```

The package is generated in `build/dist/`.

## Author

- kingmacth
- kingmacth@gmail.com

## License

Licensed under the [Apache License 2.0](./LICENSE).

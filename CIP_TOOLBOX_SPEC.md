# 西北影像 生產管理工具箱 (CIP ProdTools)

## 專案概述

單一 HTML 檔案工具箱，純前端，無後端依賴，可部署至 GitHub Pages。
品牌色：橘色 `#F5A623`（CYBER logo）、深灰 `#3D3D3D`。
製作者署名：李安峻 / 西北影像股份有限公司。

---

## 架構

```
cip_toolbox.html（單一檔案）
├── 左側固定側邊欄（工具導覽）
├── 頂部 topbar（麵包屑 + 工具標題）
└── 主內容區（tool-panel 切換）
    ├── panel-home   首頁
    ├── panel-lamp   Tool A：主燈彙整
    ├── panel-wo     Tool B：工單分析
    └── panel-posm   Tool C：POSM 包裝清單
```

JS 命名空間：`LAMP`、`WO`、`POSM`，各自獨立 IIFE，互不干擾。
新增工具只需：新增 `nav-item` + `panel-xxx div` + 對應 IIFE namespace。

外部套件（CDN）：
- `xlsx.full.min.js`（SheetJS 0.18.5）— 讀取上傳的 XLS/XLSX
- `jszip.min.js`（JSZip 3.10.1）— Tool B 的 ZIP 匯出

---

## Tool A：主燈彙整（LAMP）

**功能**：從多分頁 XLS/XLSX 中篩選含指定關鍵字的資料列，清洗並匯出報表。

**流程**：上傳檔案 → 設定篩選關鍵字與欄位名稱 → 開始處理 → 下載 XLSX / TXT

**核心邏輯**：
- 讀取所有分頁，篩選「細項描述」欄含關鍵字（預設「主燈」）的列
- 換行符號（`\n`、`\r`）替換為空格
- 欄號欄（`(欄號)`）補零：1~9 → 01~09
- 匯出：XLSX（SheetJS，含凍結列、自適應欄寬）、TXT（對齊格式含總計列）

**統計顯示**：篩選筆數、涉及單據數、張數合計、來源分頁數

---

## Tool B：工單分析（WO）

**功能**：讀取工單 Excel，依備註欄分類，合併材質後匯出分類報表。

**流程**（三步驟）：
1. 上傳工單（讀取第一個分頁）
2. 分類確認：依「分錄備註」欄自動分群，支援手動合併、重新命名、拆散、Undo
3. 分析預覽：依材質（品名規格）列出，支援跨分類合併材質、點擊查看明細彈窗

**匯出**：
- Excel（多分頁，原始資料 + 各分類/材質子頁）
- ZIP TXT（每個分類/材質一個 .txt 檔，UTF-16 LE 編碼）

**資料欄位**：單據號碼、欄號、可見寬/高、實際寬/高、比例、張數、細項描述、品名規格、分錄備註

**過濾規則**：品名規格含「費」或「車資」的列自動排除（非材料項）

---

## Tool C：POSM 包裝清單（POSM）

**功能**：上傳橫式 POSM 分配表，自動轉換為包裝人員用的直式清單，匯出 Excel。

**流程**：
1. 上傳 XLS/XLSX（可多分頁）
2. 選擇分頁（多分頁時顯示下拉選單，單一分頁自動選取）
3. 自動偵測欄位結構 → 產出包裝清單 → 下載 Excel

**自動偵測邏輯**：
- 掃描前 10 列，找到「非第一欄中 80% 以上是數字」的列 → 項次列
- 掃描項次列，找到第一個非數字的文字欄 → 門市欄（不假設固定位置，相容有客戶代碼欄的格式）
- 門市欄之後的數字欄 → 各項次號碼
- 數量 > 0 才納入

**輸出格式（v4）**：
- 每個門市一個區塊：深灰底白字抬頭列（門市名稱/項次/數量）+ 橘色底白字門市名稱（14pt 粗體，合併跨品項列）+ 品項列（黑色細框線）
- 門市間空一列，A4 直式，Excel 自動分頁
- 欄寬：A=26、B=10、C=10

**xlsx 產生方式**：純 JS 手寫 ZIP + XML（`XlsxBuilder` namespace），使用 inline strings（`t="inlineStr"`），XML 結構與 openpyxl 輸出相容，已驗證可在 Excel for Mac 正常開啟。

**頁面內容**：
- 填寫格式示意圖（base64 嵌入）
- 範例檔案下載（`上傳範例.xlsx`，base64 嵌入）

---

## XlsxBuilder（共用模組）

純 JS xlsx 產生器，不依賴任何外部套件。

**技術細節**：
- 手寫 ZIP binary（CRC32 + local file header + central directory）
- XML 結構完全對齊 openpyxl 輸出格式
- 使用 inline strings，無 sharedStrings.xml
- 靜態 XML（styles、theme、rels、Content_Types）由 openpyxl 預先產生後以 JS 字串嵌入
- 樣式索引：s=1（深灰抬頭）、s=2（橘色門市）、s=3（細框線品項）

---

## 待續開發方向

- 新增更多生產工具（架構已預留，側邊欄加 nav-item 即可）
- 部署至 GitHub Pages（`index.html`）
- 考慮後端（Vercel / Railway）以支援更複雜的 Excel 格式需求

/** 門市銷貨對帳／全部發票匯出（Excel／CSV）：只排版後端回傳之 columns／rows／summary，禁止前端重算金額 */
import type { ReconAmounts, ReconCell, ReconColumn, ReconTotals, SalesReconciliation } from '../types/api';
import { downloadCsv } from './csv';

const BRAND = 'FF083D4F';
const MUTED = 'FF8A8A8A';
const ALERT = 'FFC00000';
const MONEY_FMT = '#,##0;[Red]-#,##0';

type Row = Record<string, ReconCell>;

export type ReconDatasetKey = 'invoices' | 'invoiceItems' | 'allowances' | 'sales';

type Dataset = {
  key: ReconDatasetKey;
  label: string;
  columns: (d: SalesReconciliation) => ReconColumn[];
  rows: (d: SalesReconciliation) => Row[];
  /** 合計列（取後端 summary，不由前端加總） */
  total?: (d: SalesReconciliation) => Row;
  tone?: (r: Row) => 'muted' | 'alert' | null;
};

const invoiceTone = (r: Row) => (r.status === 'ISSUED' ? null : r.status === 'VOIDED' || r.status === 'CANCELLED' ? 'muted' : 'alert');

export const RECON_DATASETS: Dataset[] = [
  {
    key: 'invoices',
    label: '發票清冊',
    columns: (d) => d.invoiceColumns,
    rows: (d) => d.invoices,
    total: (d) => ({
      invoiceNumber: '有效發票合計（本期開立）',
      salesAmount: d.summary.invoices.effective.salesAmount,
      taxAmount: d.summary.invoices.effective.taxAmount,
      totalAmount: d.summary.invoices.effective.totalAmount,
    }),
    tone: invoiceTone,
  },
  {
    key: 'invoiceItems',
    label: '發票品項',
    columns: (d) => d.invoiceItemColumns,
    rows: (d) => d.invoiceItems,
    tone: invoiceTone,
  },
  {
    key: 'allowances',
    label: '折讓單',
    columns: (d) => d.allowanceColumns,
    rows: (d) => d.allowances,
    total: (d) => ({
      allowanceDate: '折讓合計（已開立）',
      salesAmount: d.summary.invoices.allowance.salesAmount,
      taxAmount: d.summary.invoices.allowance.taxAmount,
      totalAmount: d.summary.invoices.allowance.totalAmount,
    }),
    tone: (r) => (r.status === 'ISSUED' ? null : 'muted'),
  },
  {
    key: 'sales',
    label: '商品銷貨明細',
    columns: (d) => d.columns,
    rows: (d) => d.rows,
    total: (d) => ({
      saleDate: '合計（已收款）',
      qty: d.summary.valid.qty,
      salesAmount: d.summary.valid.salesAmount,
      taxAmount: d.summary.valid.taxAmount,
      totalAmount: d.summary.valid.totalAmount,
    }),
    tone: (r) => (r.saleStatus === 'CANCELLED' ? 'muted' : null),
  },
];

function datasetOf(key: ReconDatasetKey) {
  const ds = RECON_DATASETS.find((d) => d.key === key);
  if (!ds) throw new Error(`未知資料集 ${key}`);
  return ds;
}

function baseName(data: SalesReconciliation) {
  const scope = data.branch?.code || data.branch?.name || 'ALL';
  return `門市發票對帳_${scope}_${data.range.from}_${data.range.to}`;
}

function entityLabel(data: SalesReconciliation) {
  return data.legalEntities.map((e) => `${e.name}（統編 ${e.ubn}）`).join('、') || '—';
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadReconCsv(data: SalesReconciliation, key: ReconDatasetKey) {
  const ds = datasetOf(key);
  const rows = ds.rows(data);
  downloadCsv(`${baseName(data)}_${ds.label}.csv`, ds.columns(data), ds.total ? [...rows, ds.total(data)] : rows);
}

export async function buildReconXlsx(data: SalesReconciliation): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GymSaaS';
  wb.created = new Date(data.generatedAt);

  type Sheet = ReturnType<typeof wb.addWorksheet>;
  type XRow = ReturnType<Sheet['addRow']>;

  const brandFill = (row: XRow) => {
    row.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
  };

  const widthFor = (col: ReconColumn) => {
    if (col.type !== 'text') return col.label.length > 8 ? 18 : 12;
    if (/productName|name|itemDesc/.test(col.key)) return 30;
    if (/saleId|refId|invoiceNumber|allowanceNo|sku|branchName|voidReason|buyerName|issueMode/.test(col.key)) return 20;
    return 14;
  };

  const addTable = (sheet: Sheet, ds: Dataset) => {
    const columns = ds.columns(data);
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: widthFor(c) }));
    const head = sheet.getRow(1);
    head.height = 30;
    brandFill(head);
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    for (const r of ds.rows(data)) {
      const added = sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, r[c.key] ?? ''])));
      const tone = ds.tone?.(r);
      if (tone === 'muted') added.font = { color: { argb: MUTED }, italic: true };
      if (tone === 'alert') added.font = { color: { argb: ALERT } };
    }
    if (ds.total) {
      const total = ds.total(data);
      const t = sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, total[c.key] ?? ''])));
      t.font = { bold: true };
      t.eachCell((cell) => {
        cell.border = { top: { style: 'double', color: { argb: 'FF000000' } } };
      });
    }
    columns.forEach((c, i) => {
      if (c.type === 'text') return;
      sheet.getColumn(i + 1).numFmt = c.type === 'money' ? MONEY_FMT : '#,##0';
      sheet.getColumn(i + 1).alignment = { horizontal: 'right' };
    });
  };

  const s = data.summary;
  const inv = s.invoices;
  const summary = wb.addWorksheet('摘要');
  summary.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 12 }];
  summary.addRow(['門市發票對帳表']).font = { bold: true, size: 16, color: { argb: BRAND } };
  summary.addRow(['營業人', entityLabel(data)]);
  summary.addRow(['門市', data.branch?.name || '全部門市']);
  summary.addRow(['期間', `${data.range.from} ～ ${data.range.to}（${data.range.days} 日，台灣時間）`]);
  summary.addRow(['產製時間', new Date(data.generatedAt).toLocaleString('zh-TW', { hour12: false })]);
  summary.addRow([]);

  const section = (title: string, headers: string[]) => {
    summary.addRow([title]).font = { bold: true, size: 13, color: { argb: BRAND } };
    brandFill(summary.addRow(headers));
  };
  const amountRow = (label: string, a: ReconAmounts | (Omit<ReconAmounts, 'count'> & { count?: number }), style?: 'bold' | 'muted' | 'alert') => {
    const row = summary.addRow([label, a.salesAmount, a.taxAmount, a.totalAmount, a.count ?? '']);
    if (style === 'bold') row.font = { bold: true };
    if (style === 'muted') row.font = { color: { argb: MUTED }, italic: true };
    if (style === 'alert') row.font = { bold: true, color: { argb: ALERT } };
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = MONEY_FMT));
    return row;
  };
  const totalsRow = (label: string, t: ReconTotals, style?: 'bold' | 'muted') => {
    const row = summary.addRow([label, t.salesAmount, t.taxAmount, t.totalAmount, t.qty]);
    if (style === 'bold') row.font = { bold: true };
    if (style === 'muted') row.font = { color: { argb: MUTED }, italic: true };
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = MONEY_FMT));
  };

  section('一、發票申報彙總（依開立日期，門市全部發票）', ['項目', '銷售額（未稅）', '稅額', '總計', '張數']);
  amountRow('應稅發票', inv.byTaxType.TAXABLE);
  amountRow('免稅發票', inv.byTaxType.TAX_FREE);
  amountRow('有效發票合計', inv.effective, 'bold');
  amountRow('減：本期折讓（已開立）', inv.allowance);
  amountRow('發票淨額', inv.net, 'bold');
  amountRow('本期作廢（含前期開立）', inv.voided, 'muted');
  amountRow('開立失敗／待開立（未取得發票號）', inv.pending, inv.pending.count ? 'alert' : undefined);
  summary.addRow([]);

  section('二、有效發票依來源類別', ['來源類別', '銷售額（未稅）', '稅額', '總計', '張數']);
  if (inv.bySource.length) inv.bySource.forEach((src) => amountRow(src.label, src));
  else summary.addRow(['（本期無有效發票）']);
  summary.addRow([]);

  section('三、商品銷貨（依銷貨日期）', ['項目', '未稅金額', '稅額', '總金額', '數量']);
  totalsRow('應稅銷貨', s.byTaxType.TAXABLE);
  totalsRow('免稅銷貨', s.byTaxType.TAX_FREE);
  totalsRow(`合計（已收款 ${s.orderCount} 單）`, s.valid, 'bold');
  totalsRow(`已取消（不計入，${s.cancelledOrderCount} 單）`, s.cancelled, 'muted');
  if (s.uninvoiced.count) {
    const gap = summary.addRow(['已收款未取得發票（待補開）', '', '', s.uninvoiced.totalAmount, s.uninvoiced.count]);
    gap.font = { bold: true, color: { argb: ALERT } };
    gap.getCell(4).numFmt = MONEY_FMT;
    summary.addRow(['待補開單號', s.uninvoiced.saleIds.join('、')]);
  }
  if (s.orderAmountMismatch) {
    summary.addRow(['⚠ 單據金額與明細不符', `${s.orderAmountMismatch} 單，請洽系統管理員`]).font = { bold: true, color: { argb: ALERT } };
  }
  summary.addRow([]);
  const notes = [
    '發票清冊含門市（提供服務分店）所有來源之發票：商品銷售、會籍／儲值購案、月卡／定期定額、私教課程、團課報名、舊制合併結帳。',
    '本期開立依開立日期；前期開立、本期作廢者亦列入清冊（作廢日期欄）；開立失敗／待開立者無發票號，補開後才計入。',
    '發票品項之未稅／稅額依整張發票稅額按品項金額分攤，加總與發票一致；商品銷貨明細依銷貨日期，與發票開立日可能不同。',
  ];
  notes.forEach((n, i) => {
    const row = summary.addRow([i === 0 ? '說明' : '', n]);
    summary.mergeCells(row.number, 2, row.number, 5);
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.height = 32;
  });

  for (const ds of RECON_DATASETS) addTable(wb.addWorksheet(ds.label), ds);

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

export async function downloadReconXlsx(data: SalesReconciliation) {
  const buf = await buildReconXlsx(data);
  triggerDownload(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${baseName(data)}.xlsx`,
  );
}

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal, Select } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import {
  createHqProduct,
  fetchHqProducts,
  getErrorMessage,
  updateHqProduct,
  type ProductMasterInput,
} from '../../../../lib/api';
import { PRODUCT_KIND_LABEL, TAX_TYPE_LABEL } from '../../../../lib/inventoryLabels';
import type { ProductKind, ProductMaster, TaxType } from '../../../../types/api';

type Draft = {
  sku: string;
  barcode: string;
  name: string;
  invoiceName: string;
  unit: string;
  productKind: ProductKind;
  taxType: TaxType;
  listPrice: string;
  isActive: boolean;
};

const EMPTY: Draft = {
  sku: '',
  barcode: '',
  name: '',
  invoiceName: '',
  unit: '個',
  productKind: 'PHYSICAL',
  taxType: 'TAXABLE',
  listPrice: '',
  isActive: true,
};

function toPayload(d: Draft): Partial<ProductMasterInput> | string {
  const listPrice = d.listPrice.trim() === '' ? 0 : Number(d.listPrice);
  if (!Number.isInteger(listPrice) || listPrice < 0) return '建議售價須為非負整數（元）';
  return {
    sku: d.sku.trim(),
    barcode: d.barcode.trim() || null,
    name: d.name.trim(),
    invoiceName: d.invoiceName.trim() || null,
    unit: d.unit.trim() || '個',
    productKind: d.productKind,
    taxType: d.taxType,
    listPrice,
  };
}

function ProductFields({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });
  return (
    <>
      <div className="bind-row">
        <Field label="SKU">
          <Input value={draft.sku} onChange={(e) => set('sku', e.target.value.toUpperCase())} required maxLength={40} />
        </Field>
        <Field label="條碼" hint="選填">
          <Input value={draft.barcode} onChange={(e) => set('barcode', e.target.value)} maxLength={32} />
        </Field>
      </div>
      <Field label="商品名稱">
        <Input value={draft.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} />
      </Field>
      <div className="bind-row">
        <Field label="發票品名" hint="選填；空白用商品名稱（30 字內）">
          <Input value={draft.invoiceName} onChange={(e) => set('invoiceName', e.target.value)} maxLength={30} />
        </Field>
        <Field label="單位">
          <Input value={draft.unit} onChange={(e) => set('unit', e.target.value)} maxLength={6} />
        </Field>
      </div>
      <div className="bind-row">
        <Field label="商品類型">
          <Select value={draft.productKind} onChange={(e) => set('productKind', e.target.value as ProductKind)}>
            <option value="PHYSICAL">實體商品（控管庫存）</option>
            <option value="SERVICE">服務類（不控庫存）</option>
          </Select>
        </Field>
        <Field label="課稅別" hint="決定發票稅別與分張">
          <Select value={draft.taxType} onChange={(e) => set('taxType', e.target.value as TaxType)}>
            <option value="TAXABLE">應稅 5%</option>
            <option value="ZERO">零稅率</option>
            <option value="FREE">免稅</option>
          </Select>
        </Field>
      </div>
      <Field label="建議售價（含稅）" hint="分店可另設售價；未設則用此價">
        <Input type="number" min={0} step={1} value={draft.listPrice} onChange={(e) => set('listPrice', e.target.value)} />
      </Field>
    </>
  );
}

/** 商品主檔：全公司共用 SKU；不含庫存／成本（成本由驗收移動平均產生） */
export default function ProductMasterPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<ProductMaster[]>([]);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProductMaster | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    fetchHqProducts()
      .then((res) => {
        if (!cancelled) setRows(res.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入商品主檔失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  const term = q.trim().toLowerCase();
  const filtered = rows.filter(
    (p) => !term || [p.sku, p.name, p.barcode || ''].some((v) => v.toLowerCase().includes(term)),
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (inFlightRef.current) return;
    const payload = toPayload(draft);
    if (typeof payload === 'string') {
      toast(payload, 'error');
      return;
    }
    inFlightRef.current = true;
    setCreating(true);
    try {
      const res = await createHqProduct(payload);
      toast(res.message || '商品已建立', 'success');
      setDraft(EMPTY);
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '建立商品失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setCreating(false);
    }
  }

  function openEdit(p: ProductMaster) {
    setEditing(p);
    setEditDraft({
      sku: p.sku,
      barcode: p.barcode || '',
      name: p.name,
      invoiceName: p.invoiceName || '',
      unit: p.unit,
      productKind: p.productKind,
      taxType: p.taxType,
      listPrice: String(p.listPrice),
      isActive: p.isActive,
    });
  }

  async function handleSave() {
    if (!editing || inFlightRef.current) return;
    const payload = toPayload(editDraft);
    if (typeof payload === 'string') {
      toast(payload, 'error');
      return;
    }
    inFlightRef.current = true;
    setSaving(true);
    try {
      const res = await updateHqProduct(editing.id, { ...payload, isActive: editDraft.isActive });
      toast(res.message || '商品已更新', 'success');
      setEditing(null);
      reload();
    } catch (err) {
      toast(getErrorMessage(err, '更新商品失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="staff-grid mt-lg">
      <Card title="新增商品" subtitle="建立後各分店庫存 0；至「分店庫存」上架、經採購驗收入庫">
        <form onSubmit={handleCreate} className="form-stack">
          <ProductFields draft={draft} onChange={setDraft} />
          <Button type="submit" loading={creating}>
            建立商品
          </Button>
        </form>
      </Card>

      <Card title="商品一覽" subtitle={`共 ${rows.length} 項 · 總庫存為各分店加總`}>
        <div className="list-toolbar">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋 SKU／名稱／條碼"
            aria-label="搜尋商品"
            style={{ maxWidth: 260 }}
          />
        </div>
        <div className="table-wrap mt-md">
          <table className="data-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>名稱</th>
                <th>類型</th>
                <th>課稅別</th>
                <th>建議售價</th>
                <th>總庫存</th>
                <th>上架分店</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-muted text-center">
                    {rows.length === 0 ? '尚無商品' : '沒有符合的商品'}
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.sku}</td>
                    <td>
                      {p.name}
                      {p.invoiceName ? <div className="text-sm text-muted">發票：{p.invoiceName}</div> : null}
                    </td>
                    <td>
                      <Badge tone={p.productKind === 'SERVICE' ? 'info' : 'neutral'}>
                        {PRODUCT_KIND_LABEL[p.productKind] || p.productKind}
                      </Badge>
                    </td>
                    <td>{TAX_TYPE_LABEL[p.taxType] || p.taxType}</td>
                    <td>${p.listPrice}</td>
                    <td>{p.productKind === 'SERVICE' ? '—' : `${p.totalOnHand} ${p.unit}`}</td>
                    <td>{p.listedBranchIds.length}</td>
                    <td>
                      <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? '啟用' : '停售'}</Badge>
                    </td>
                    <td>
                      <Button size="sm" variant="secondary" onClick={() => openEdit(p)}>
                        編輯
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        open={editing !== null}
        title={`編輯商品 · ${editing?.sku || ''}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button loading={saving} onClick={() => void handleSave()}>
              儲存
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <ProductFields draft={editDraft} onChange={setEditDraft} />
          {editing && editing.totalOnHand !== 0 && editDraft.productKind !== editing.productKind && (
            <Alert tone="warning">仍有分店庫存，後端將拒絕變更商品類型（請先盤點歸零）</Alert>
          )}
          <label className="checkbox-item">
            <input
              type="checkbox"
              checked={editDraft.isActive}
              onChange={(e) => setEditDraft({ ...editDraft, isActive: e.target.checked })}
            />
            啟用（停售後各分店 POS 皆不可售）
          </label>
        </div>
      </Modal>
    </div>
  );
}

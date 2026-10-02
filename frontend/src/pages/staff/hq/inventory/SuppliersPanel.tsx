import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, Select } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import { createHqSupplier, fetchHqSuppliers, getErrorMessage, updateHqSupplier, type SupplierInput } from '../../../../lib/api';
import { PAYMENT_TERM_LABEL } from '../../../../lib/inventoryLabels';
import type { Supplier, SupplierPaymentTerm } from '../../../../types/api';

type Draft = {
  name: string;
  ubn: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  paymentTermType: SupplierPaymentTerm;
  paymentTermDays: string;
  note: string;
  isActive: boolean;
};

const EMPTY: Draft = {
  name: '',
  ubn: '',
  contactName: '',
  phone: '',
  email: '',
  address: '',
  paymentTermType: 'NET',
  paymentTermDays: '30',
  note: '',
  isActive: true,
};

function toDraft(s: Supplier): Draft {
  return {
    name: s.name,
    ubn: s.ubn || '',
    contactName: s.contactName || '',
    phone: s.phone || '',
    email: s.email || '',
    address: s.address || '',
    paymentTermType: s.paymentTermType,
    paymentTermDays: String(s.paymentTermDays),
    note: s.note || '',
    isActive: s.isActive,
  };
}

function toPayload(d: Draft): Partial<SupplierInput> {
  return {
    name: d.name.trim(),
    ubn: d.ubn.trim() || null,
    contactName: d.contactName.trim() || null,
    phone: d.phone.trim() || null,
    email: d.email.trim() || null,
    address: d.address.trim() || null,
    paymentTermType: d.paymentTermType,
    paymentTermDays: parseInt(d.paymentTermDays, 10) || 0,
    note: d.note.trim() || null,
    isActive: d.isActive,
  };
}

/** 供應商主檔（全公司共用）；付款條件決定應付到期日 */
export default function SuppliersPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<Supplier[]>([]);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchHqSuppliers()
      .then((res) => {
        if (!cancelled) setRows(res.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入供應商失敗'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, toast]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function handleSave() {
    if (editingId === null || inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving(true);
    try {
      const payload = toPayload(draft);
      const res = editingId === 'new' ? await createHqSupplier(payload) : await updateHqSupplier(editingId, payload);
      toast(res.message || '已儲存', 'success');
      setEditingId(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '儲存供應商失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <Card title="供應商" className="mt-lg" subtitle={`共 ${rows.length} 家`}>
        <div className="list-toolbar">
          <Button
            onClick={() => {
              setDraft(EMPTY);
              setEditingId('new');
            }}
          >
            新增供應商
          </Button>
        </div>
        <div className="table-wrap mt-md">
          <table className="data-table">
            <thead>
              <tr>
                <th>名稱</th>
                <th>統編</th>
                <th>聯絡人</th>
                <th>電話</th>
                <th>付款條件</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-muted text-center">
                    尚無供應商
                  </td>
                </tr>
              ) : (
                rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td className="mono">{s.ubn || '—'}</td>
                    <td>{s.contactName || '—'}</td>
                    <td>{s.phone || '—'}</td>
                    <td>
                      {s.paymentTermType === 'COD'
                        ? PAYMENT_TERM_LABEL.COD
                        : (PAYMENT_TERM_LABEL[s.paymentTermType] || s.paymentTermType).replace('N', String(s.paymentTermDays))}
                    </td>
                    <td>
                      <Badge tone={s.isActive ? 'success' : 'neutral'}>{s.isActive ? '往來中' : '停用'}</Badge>
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDraft(toDraft(s));
                          setEditingId(s.id);
                        }}
                      >
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
        open={editingId !== null}
        title={editingId === 'new' ? '新增供應商' : '編輯供應商'}
        onClose={() => setEditingId(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingId(null)}>
              取消
            </Button>
            <Button loading={saving} disabled={!draft.name.trim()} onClick={() => void handleSave()}>
              儲存
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Field label="名稱">
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={100} required />
          </Field>
          <div className="bind-row">
            <Field label="統編" hint="選填；後端驗檢查碼">
              <Input value={draft.ubn} onChange={(e) => set('ubn', e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} />
            </Field>
            <Field label="聯絡人">
              <Input value={draft.contactName} onChange={(e) => set('contactName', e.target.value)} />
            </Field>
          </div>
          <div className="bind-row">
            <Field label="電話">
              <Input value={draft.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
            <Field label="Email">
              <Input type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} />
            </Field>
          </div>
          <Field label="地址">
            <Input value={draft.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <div className="bind-row">
            <Field label="付款條件">
              <Select value={draft.paymentTermType} onChange={(e) => set('paymentTermType', e.target.value as SupplierPaymentTerm)}>
                <option value="NET">進貨後 N 天</option>
                <option value="EOM">月結 N 天</option>
                <option value="COD">貨到付款</option>
              </Select>
            </Field>
            {draft.paymentTermType !== 'COD' && (
              <Field label="天數" hint="0～180">
                <Input type="number" min={0} max={180} value={draft.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value)} />
              </Field>
            )}
          </div>
          <Field label="備註">
            <Input value={draft.note} onChange={(e) => set('note', e.target.value)} />
          </Field>
          <label className="checkbox-item">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            往來中（停用後不可建立新採購單）
          </label>
        </div>
      </Modal>
    </>
  );
}

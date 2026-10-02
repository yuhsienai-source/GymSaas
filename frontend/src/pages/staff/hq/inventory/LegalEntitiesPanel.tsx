import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Field, Input, Modal } from '../../../../components/ui';
import { useToast } from '../../../../contexts/ToastContext';
import {
  createHqLegalEntity,
  fetchHqLegalEntities,
  getErrorMessage,
  updateHqLegalEntity,
  type LegalEntityInput,
} from '../../../../lib/api';
import type { LegalEntity } from '../../../../types/api';

type Draft = { code: string; name: string; ubn: string; address: string; phone: string; ezpayMerchantId: string; isActive: boolean };

const EMPTY: Draft = { code: '', name: '', ubn: '', address: '', phone: '', ezpayMerchantId: '', isActive: true };

function toPayload(d: Draft): Partial<LegalEntityInput> {
  return {
    code: d.code.trim().toUpperCase(),
    name: d.name.trim(),
    ubn: d.ubn.trim(),
    address: d.address.trim() || null,
    phone: d.phone.trim() || null,
    ezpayMerchantId: d.ezpayMerchantId.trim() || null,
    isActive: d.isActive,
  };
}

/** 營業人＝獨立統編＝獨立 ezPay 商店。HashKey／HashIV 只放後端 env（EZPAY_{代碼}_HASH_KEY／_HASH_IV），此頁只顯示是否齊備 */
export default function LegalEntitiesPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<LegalEntity[]>([]);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const inFlightRef = useRef(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchHqLegalEntities()
      .then((res) => {
        if (!cancelled) setRows(res.data || []);
      })
      .catch((err) => {
        if (!cancelled) toast(getErrorMessage(err, '載入營業人失敗'), 'error');
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
      const res = editingId === 'new' ? await createHqLegalEntity(payload) : await updateHqLegalEntity(editingId, payload);
      toast(res.message || '已儲存', 'success');
      setEditingId(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(getErrorMessage(err, '儲存營業人失敗'), 'error');
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <Card title="營業人（統編）" className="mt-lg" subtitle="分店於「分店場地」綁定營業人；發票、採購、應付皆依營業人分帳，跨營業人禁止直接調撥">
        <div className="list-toolbar">
          <Button
            onClick={() => {
              setDraft(EMPTY);
              setEditingId('new');
            }}
          >
            新增營業人
          </Button>
        </div>
        <div className="table-wrap mt-md">
          <table className="data-table">
            <thead>
              <tr>
                <th>代碼</th>
                <th>名稱</th>
                <th>統編</th>
                <th>ezPay 商店</th>
                <th>金鑰設定</th>
                <th>分店</th>
                <th>狀態</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-muted text-center">
                    尚無營業人
                  </td>
                </tr>
              ) : (
                rows.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.code}</td>
                    <td>{e.name}</td>
                    <td className="mono">{e.ubn}</td>
                    <td className="mono">{e.ezpay.merchantId || <span className="text-muted">未設定</span>}</td>
                    <td>
                      {e.ezpay.configured ? (
                        <Badge tone="success">齊備</Badge>
                      ) : (
                        <>
                          <Badge tone="danger">缺漏</Badge>
                          <div className="text-sm text-muted mono">{e.ezpay.missing.join('、')}</div>
                        </>
                      )}
                    </td>
                    <td className="text-sm">{(e.branches || []).map((b) => b.name).join('、') || '—'}</td>
                    <td>
                      <Badge tone={e.isActive ? 'success' : 'neutral'}>{e.isActive ? '啟用' : '停用'}</Badge>
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setDraft({
                            code: e.code,
                            name: e.name,
                            ubn: e.ubn,
                            address: e.address || '',
                            phone: e.phone || '',
                            ezpayMerchantId: e.ezpayMerchantId || '',
                            isActive: e.isActive,
                          });
                          setEditingId(e.id);
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
        title={editingId === 'new' ? '新增營業人' : '編輯營業人'}
        onClose={() => setEditingId(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingId(null)}>
              取消
            </Button>
            <Button loading={saving} disabled={!draft.code.trim() || !draft.name.trim() || !draft.ubn.trim()} onClick={() => void handleSave()}>
              儲存
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <Alert tone="info">
            ezPay HashKey／HashIV 請設定於後端環境變數 <code>EZPAY_{draft.code.trim().toUpperCase() || '代碼'}_HASH_KEY</code>／
            <code>_HASH_IV</code>，嚴禁輸入於此。已開過發票之營業人不可改代碼或統編。
          </Alert>
          <div className="bind-row">
            <Field label="代碼" hint="英數大寫，對應 env 變數名">
              <Input value={draft.code} onChange={(e) => set('code', e.target.value.toUpperCase())} maxLength={10} required />
            </Field>
            <Field label="統編" hint="8 碼；後端驗檢查碼">
              <Input value={draft.ubn} onChange={(e) => set('ubn', e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} required />
            </Field>
          </div>
          <Field label="營業人名稱（發票抬頭）">
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} maxLength={60} required />
          </Field>
          <Field label="ezPay 商店代號（MerchantID）" hint="選填；亦可由 env EZPAY_{代碼}_MERCHANT_ID 提供">
            <Input value={draft.ezpayMerchantId} onChange={(e) => set('ezpayMerchantId', e.target.value.trim())} maxLength={20} />
          </Field>
          <div className="bind-row">
            <Field label="地址">
              <Input value={draft.address} onChange={(e) => set('address', e.target.value)} />
            </Field>
            <Field label="電話">
              <Input value={draft.phone} onChange={(e) => set('phone', e.target.value)} />
            </Field>
          </div>
          <label className="checkbox-item">
            <input type="checkbox" checked={draft.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            啟用
          </label>
        </div>
      </Modal>
    </>
  );
}

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Alert, Badge, Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqGateDevice,
  fetchHqGateDevices,
  getErrorMessage,
  rotateHqGateDeviceKey,
  updateHqGateDevice,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { encodeGatePairQr } from '../../../lib/gatePairQr';
import type { Branch, GateDevice } from '../../../types/api';
import type { HqDataProps } from './types';

function formatWhen(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW');
  } catch {
    return String(iso);
  }
}

export default function HqGateDevicesTab({
  branches,
}: Pick<HqDataProps, 'branches'>) {
  const { toast } = useToast();
  const [devices, setDevices] = useState<GateDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterBranchId, setFilterBranchId] = useState<number | ''>('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState<number | ''>(branches[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [revealedKey, setRevealedKey] = useState<{
    code: string;
    deviceKey: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchHqGateDevices(
        filterBranchId === '' ? undefined : Number(filterBranchId),
      );
      setDevices((res.data as GateDevice[]) || []);
    } catch (err) {
      toast(getErrorMessage(err, '讀取閘機裝置失敗'), 'error');
    } finally {
      setLoading(false);
    }
  }, [filterBranchId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (branchId === '' && branches[0]?.id) setBranchId(branches[0].id);
  }, [branches, branchId]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || !name.trim() || !branchId) {
      toast('請填寫代碼、名稱與分店', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await createHqGateDevice({
        code: code.trim(),
        name: name.trim(),
        branchId: Number(branchId),
      });
      toast(res.message || '裝置已建立', 'success');
      const key = (res.data as GateDevice | undefined)?.deviceKey;
      if (key) {
        setRevealedKey({
          code: (res.data as GateDevice).code,
          deviceKey: key,
        });
      }
      setCode('');
      setName('');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(d: GateDevice) {
    setBusy(true);
    try {
      const res = await updateHqGateDevice(d.id, { isActive: !d.isActive });
      toast(res.message || '已更新', 'success');
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '更新失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRotate(d: GateDevice) {
    if (
      !window.confirm(
        `確定輪替 [${d.code}] 的裝置金鑰？\n舊金鑰立即失效，請更新閘機配對。`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await rotateHqGateDeviceKey(d.id);
      toast(res.message || '金鑰已輪替', 'success');
      const key = (res.data as GateDevice | undefined)?.deviceKey;
      if (key) {
        setRevealedKey({ code: (res.data as GateDevice).code, deviceKey: key });
      }
      await load();
    } catch (err) {
      toast(getErrorMessage(err, '輪替失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey.deviceKey);
      toast('金鑰已複製', 'success');
    } catch {
      toast('複製失敗，請手動選取', 'error');
    }
  }

  const pairQrValue = revealedKey
    ? encodeGatePairQr(revealedKey.code, revealedKey.deviceKey)
    : '';

  return (
    <>
      <PageSection
        title="進出場裝置"
        desc="閘機／掃碼機綁定分店 · 裝置金鑰驗證 · 可用配對 QR 掃入另一台機"
      >
        {revealedKey ? (
          <Alert tone="warning">
            <strong>請立即用閘機掃碼配對</strong>
            <div className="text-sm" style={{ marginTop: 6 }}>
              裝置 <span className="mono">{revealedKey.code}</span>
              ：打開另一台機的 <span className="mono">/gate</span>
              ，掃描下方 QR（金鑰僅顯示一次）。
            </div>
            <div className="gate-pair-qr">
              <QRCodeSVG value={pairQrValue} size={220} level="M" includeMargin />
            </div>
            <details className="gate-pair-qr__manual">
              <summary>改為手動輸入／複製金鑰</summary>
              <code
                className="mono"
                style={{
                  display: 'block',
                  marginTop: 8,
                  padding: '0.5rem',
                  wordBreak: 'break-all',
                  background: 'var(--surface-2, #f4f4f5)',
                }}
              >
                {revealedKey.deviceKey}
              </code>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <Button size="sm" onClick={() => void copyKey()}>
                  複製金鑰
                </Button>
              </div>
            </details>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <Button size="sm" variant="ghost" onClick={() => setRevealedKey(null)}>
                已掃碼／妥善保存，關閉
              </Button>
            </div>
          </Alert>
        ) : null}

        <Card title="新增裝置" subtitle="建立後顯示配對 QR，於 /gate 掃碼即可">
          <form onSubmit={handleCreate} className="form-stack">
            <Field label="裝置代碼" hint="如 HP-IN-01（唯一）">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="HP-IN-01"
                required
              />
            </Field>
            <Field label="顯示名稱">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="和平店進場閘"
                required
              />
            </Field>
            <Field label="綁定分店">
              <Select
                value={branchId === '' ? '' : String(branchId)}
                onChange={(e) =>
                  setBranchId(e.target.value ? Number(e.target.value) : '')
                }
                required
              >
                <option value="">— 請選擇 —</option>
                {branches
                  .filter((b) => b.isActive !== false)
                  .map((b: Branch) => (
                    <option key={b.id} value={b.id}>
                      {staffBranchLabel(b) || b.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button type="submit" loading={busy}>
              建立並產生配對 QR
            </Button>
          </form>
        </Card>
      </PageSection>

      <PageSection title="裝置一覽" desc={loading ? '載入中…' : `${devices.length} 台`}>
        <div className="table-toolbar">
          <Select
            value={filterBranchId === '' ? '' : String(filterBranchId)}
            onChange={(e) =>
              setFilterBranchId(e.target.value ? Number(e.target.value) : '')
            }
            style={{ maxWidth: 220 }}
            aria-label="篩選分店"
          >
            <option value="">全部分店</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {staffBranchLabel(b) || b.name}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            重新整理
          </Button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>代碼</th>
                <th>名稱</th>
                <th>分店</th>
                <th>金鑰前綴</th>
                <th>狀態</th>
                <th>最後連線</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-muted" style={{ padding: '2rem' }}>
                    {loading ? '載入中…' : '尚無閘機裝置'}
                  </td>
                </tr>
              ) : (
                devices.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.code}</td>
                    <td>{d.name}</td>
                    <td>{d.branchLabel || staffBranchLabel(d.branch)}</td>
                    <td className="mono text-sm">{d.keyPrefix ? `${d.keyPrefix}…` : '—'}</td>
                    <td>
                      <Badge tone={d.isActive ? 'success' : 'neutral'}>
                        {d.isActive ? '啟用' : '停用'}
                      </Badge>
                    </td>
                    <td className="text-sm">{formatWhen(d.lastSeenAt)}</td>
                    <td className="table-actions">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void handleRotate(d)}
                      >
                        輪替金鑰
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void handleToggle(d)}
                      >
                        {d.isActive ? '停用' : '啟用'}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </PageSection>
    </>
  );
}

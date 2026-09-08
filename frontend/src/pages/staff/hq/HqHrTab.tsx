import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Button, Card, Field, Input, PageSection, Select } from '../../../components/ui';
import { useToast } from '../../../contexts/ToastContext';
import {
  createHqHrLeave,
  createHqHrSchedule,
  fetchHqHrAttendance,
  fetchHqHrLeaves,
  fetchHqHrSchedules,
  getErrorMessage,
  patchHqHrLeave,
  staffHrPunchIn,
  staffHrPunchOut,
} from '../../../lib/api';
import type { StaffAttendanceRow, StaffLeaveRow, StaffScheduleRow } from '../../../types/api';
import type { HqDataProps } from './types';

export default function HqHrTab({ staffList }: Pick<HqDataProps, 'staffList'>) {
  const { toast } = useToast();
  const [section, setSection] = useState<'attendance' | 'leaves' | 'schedules' | 'self'>('attendance');
  const [attendance, setAttendance] = useState<StaffAttendanceRow[]>([]);
  const [leaves, setLeaves] = useState<StaffLeaveRow[]>([]);
  const [schedules, setSchedules] = useState<StaffScheduleRow[]>([]);
  const [busy, setBusy] = useState(false);

  const [staffId, setStaffId] = useState<number | ''>('');
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [schedStart, setSchedStart] = useState('');
  const [schedEnd, setSchedEnd] = useState('');

  const load = useCallback(async () => {
    try {
      const [attRes, leaveRes, schedRes] = await Promise.all([
        fetchHqHrAttendance({ take: 100 }),
        fetchHqHrLeaves({ take: 100 }),
        fetchHqHrSchedules({ take: 100 }),
      ]);
      if (attRes.status === 'success' && attRes.data) setAttendance(attRes.data);
      if (leaveRes.status === 'success' && leaveRes.data) setLeaves(leaveRes.data);
      if (schedRes.status === 'success' && schedRes.data) setSchedules(schedRes.data);
    } catch (err) {
      toast(getErrorMessage(err, '載入 HR 資料失敗'), 'error');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!staffId && staffList[0]) setStaffId(staffList[0].id);
  }, [staffList, staffId]);

  async function onCreateLeave(e: FormEvent) {
    e.preventDefault();
    if (staffId === '' || !leaveStart || !leaveEnd) return;
    setBusy(true);
    try {
      const res = await createHqHrLeave({
        staffId: Number(staffId),
        startAt: new Date(leaveStart).toISOString(),
        endAt: new Date(leaveEnd).toISOString(),
      });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') void load();
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSchedule(e: FormEvent) {
    e.preventDefault();
    if (staffId === '' || !schedStart || !schedEnd) return;
    setBusy(true);
    try {
      const res = await createHqHrSchedule({
        staffId: Number(staffId),
        startAt: new Date(schedStart).toISOString(),
        endAt: new Date(schedEnd).toISOString(),
      });
      toast(res.message || '已建立', res.status === 'success' ? 'success' : 'error');
      if (res.status === 'success') void load();
    } catch (err) {
      toast(getErrorMessage(err, '建立失敗'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageSection title="員工 HR" desc="考勤、請假、排班；員工可自助打卡">
      <nav className="hq-tabs" role="tablist">
        {(['attendance', 'leaves', 'schedules', 'self'] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`hq-tabs__btn ${section === key ? 'is-active' : ''}`}
            onClick={() => setSection(key)}
          >
            {key === 'attendance'
              ? '考勤'
              : key === 'leaves'
                ? '請假'
                : key === 'schedules'
                  ? '排班'
                  : '自助打卡'}
          </button>
        ))}
      </nav>

      {section === 'self' && (
        <Card title="員工自助打卡">
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button
              onClick={async () => {
                try {
                  const res = await staffHrPunchIn();
                  toast(res.message || '已上班', 'success');
                  void load();
                } catch (err) {
                  toast(getErrorMessage(err, '打卡失敗'), 'error');
                }
              }}
            >
              上班打卡
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  const res = await staffHrPunchOut();
                  toast(res.message || '已下班', 'success');
                  void load();
                } catch (err) {
                  toast(getErrorMessage(err, '打卡失敗'), 'error');
                }
              }}
            >
              下班打卡
            </Button>
          </div>
        </Card>
      )}

      {(section === 'leaves' || section === 'schedules') && (
        <Card title={section === 'leaves' ? '建立請假' : '建立排班'} className="mb-md">
          <form onSubmit={section === 'leaves' ? onCreateLeave : onCreateSchedule}>
            <Field label="員工">
              <Select
                value={staffId === '' ? '' : String(staffId)}
                onChange={(e) => setStaffId(e.target.value ? Number(e.target.value) : '')}
              >
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName || s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="開始">
              <Input
                type="datetime-local"
                value={section === 'leaves' ? leaveStart : schedStart}
                onChange={(e) =>
                  section === 'leaves'
                    ? setLeaveStart(e.target.value)
                    : setSchedStart(e.target.value)
                }
                required
              />
            </Field>
            <Field label="結束">
              <Input
                type="datetime-local"
                value={section === 'leaves' ? leaveEnd : schedEnd}
                onChange={(e) =>
                  section === 'leaves' ? setLeaveEnd(e.target.value) : setSchedEnd(e.target.value)
                }
                required
              />
            </Field>
            <Button type="submit" loading={busy}>
              建立
            </Button>
          </form>
        </Card>
      )}

      {section === 'attendance' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>上班</th>
                <th>下班</th>
              </tr>
            </thead>
            <tbody>
              {attendance.map((a) => (
                <tr key={a.id}>
                  <td>{a.staff?.displayName || a.staff?.name}</td>
                  <td>{new Date(a.punchIn).toLocaleString('zh-TW')}</td>
                  <td>{a.punchOut ? new Date(a.punchOut).toLocaleString('zh-TW') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section === 'leaves' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>期間</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((l) => (
                <tr key={l.id}>
                  <td>{l.staff?.displayName || l.staff?.name}</td>
                  <td>
                    {new Date(l.startAt).toLocaleString('zh-TW')} –{' '}
                    {new Date(l.endAt).toLocaleString('zh-TW')}
                  </td>
                  <td>{l.status}</td>
                  <td>
                    {l.status === 'PENDING' && (
                      <>
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await patchHqHrLeave(l.id, { status: 'APPROVED' });
                              toast('已核准', 'success');
                              void load();
                            } catch (err) {
                              toast(getErrorMessage(err, '失敗'), 'error');
                            }
                          }}
                        >
                          核准
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            try {
                              await patchHqHrLeave(l.id, { status: 'REJECTED' });
                              toast('已拒絕', 'success');
                              void load();
                            } catch (err) {
                              toast(getErrorMessage(err, '失敗'), 'error');
                            }
                          }}
                        >
                          拒絕
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section === 'schedules' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>員工</th>
                <th>開始</th>
                <th>結束</th>
                <th>類型</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.staff?.displayName || s.staff?.name}</td>
                  <td>{new Date(s.startAt).toLocaleString('zh-TW')}</td>
                  <td>{new Date(s.endAt).toLocaleString('zh-TW')}</td>
                  <td>{s.slotType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageSection>
  );
}

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from '../../ui';
import {
  getErrorMessage,
  fetchConsultGuests,
  scheduleConsultGuest,
  schedulePrivateSession,
} from '../../../lib/api';
import { staffBranchLabel } from '../../../lib/branchLabel';
import { useToast } from '../../../contexts/ToastContext';
import type {
  ConsultGuest,
  TrainerDashboardClass,
  TrainerPtContract,
  Venue,
} from '../../../types/api';
import { formatExpire, money } from './trainerFormat';

type BookMode = 'student' | 'consult';

type Props = {
  venues: Venue[];
  ptContracts: TrainerPtContract[];
  selectedClass: TrainerDashboardClass | null;
  onSelectClass: (c: TrainerDashboardClass | null) => void;
  onBooked: () => Promise<void> | void;
  initialMemberId?: number | null;
  viewAsTrainerId?: number;
};

const DURATION_OPTIONS = [30, 45, 50, 60, 90, 120];
const DEFAULT_DURATION = 60;

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function padTime(hhmm: string) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return '';
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

/** 台北牆鐘 → ISO（+08:00） */
function toTaipeiIso(dateYmd: string, timeHm: string) {
  const t = padTime(timeHm);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd) || !t) return null;
  return `${dateYmd}T${t}:00+08:00`;
}

function addMinutesIso(startIso: string, minutes: number) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + minutes * 60_000).toISOString();
}

function partsFromIso(iso: string | null | undefined) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function contractLabel(c: TrainerPtContract) {
  const remain = `${c.remainingSessions}/${c.totalSessions} 堂`;
  const price = money(c.pricePaid);
  const branch = c.branchName || c.branchCode || '';
  return branch
    ? `私教合約 #${c.id} · ${branch} · 剩 ${remain} · ${price}`
    : `私教合約 #${c.id} · 剩 ${remain} · ${price}`;
}

/** HP↔HR 私教場地共享（與後端 branchShare 對齊） */
const PRIVATE_VENUE_SHARE: Record<string, string[]> = {
  HP: ['HP', 'HR'],
  HR: ['HP', 'HR'],
};

function privateVenueAllowed(contract: TrainerPtContract | null, venue: Venue | null) {
  if (!contract || !venue) return true;
  if (!contract.branchId) return true;
  if (venue.branchId === contract.branchId) return true;
  const buy = (contract.branchCode || '').toUpperCase();
  const at = (venue.branch?.code || '').toUpperCase();
  if (!buy || !at) return venue.branchId === contract.branchId;
  const group = PRIVATE_VENUE_SHARE[buy];
  return Boolean(group && group.includes(at));
}

export default function TrainerBookPanel({
  venues,
  ptContracts,
  selectedClass,
  onSelectClass,
  onBooked,
  initialMemberId,
  viewAsTrainerId,
}: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<BookMode>(
    selectedClass?.type === 'CONSULT' ? 'consult' : 'student',
  );
  const [studentQuery, setStudentQuery] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState<number | ''>('');
  const [contractId, setContractId] = useState<number | ''>('');
  const [venueId, setVenueId] = useState<number | ''>('');
  const [stationId, setStationId] = useState<number | ''>('');
  const [bookDate, setBookDate] = useState(todayYmd);
  const [bookTime, setBookTime] = useState('');
  const [durationMin, setDurationMin] = useState(DEFAULT_DURATION);
  const [bookBusy, setBookBusy] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestNote, setGuestNote] = useState('');
  const [guests, setGuests] = useState<ConsultGuest[]>([]);
  const [guestQuery, setGuestQuery] = useState('');
  const [selectedGuestId, setSelectedGuestId] = useState<number | ''>('');
  const [lastNotify, setLastNotify] = useState<{
    ok: boolean;
    skipped: boolean;
    reason: string | null;
    memberName: string;
    classTitle: string;
  } | null>(null);

  const appliedInitialKey = initialMemberId ?? null;
  const [seenInitialKey, setSeenInitialKey] = useState<number | null>(appliedInitialKey);
  if (appliedInitialKey !== seenInitialKey) {
    setSeenInitialKey(appliedInitialKey);
    if (
      appliedInitialKey != null &&
      ptContracts.some((c) => c.memberId === appliedInitialKey)
    ) {
      setMode('student');
      setSelectedMemberId(appliedInitialKey);
    }
  }

  // 課表點選私教／諮詢 → 帶入場地與時段
  useEffect(() => {
    if (!selectedClass) return;
    if (selectedClass.type === 'CONSULT') setMode('consult');
    if (selectedClass.type === 'PRIVATE') setMode('student');
    if (selectedClass.venueId) setVenueId(selectedClass.venueId);
    if (selectedClass.stationId) setStationId(selectedClass.stationId);
    const parts = partsFromIso(selectedClass.startAt);
    if (parts.date) setBookDate(parts.date);
    if (parts.time) setBookTime(parts.time);
    const start = new Date(selectedClass.startAt).getTime();
    const end = new Date(selectedClass.endAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const mins = Math.round((end - start) / 60_000);
      if (DURATION_OPTIONS.includes(mins)) setDurationMin(mins);
    }
  }, [selectedClass?.id]);

  useEffect(() => {
    if (mode !== 'consult') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchConsultGuests({
          q: guestQuery || undefined,
          viewAsTrainerId,
        });
        if (!cancelled) setGuests((res.data as ConsultGuest[]) || []);
      } catch {
        if (!cancelled) setGuests([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, guestQuery, viewAsTrainerId]);

  const filteredStudents = useMemo(() => {
    const needle = studentQuery.trim().toLowerCase();
    let list = ptContracts;
    if (needle) {
      list = list.filter((c) => {
        const hay =
          `${c.memberName || ''} ${c.memberPhone || ''} ${c.memberNo || ''} ${c.memberId}`.toLowerCase();
        return hay.includes(needle);
      });
    }
    // 同一學員可能多份合約：列表以學員去重，優先剩堂多的
    const byMember = new Map<number, TrainerPtContract>();
    for (const c of [...list].sort((a, b) => b.remainingSessions - a.remainingSessions)) {
      if (!byMember.has(c.memberId)) byMember.set(c.memberId, c);
    }
    return [...byMember.values()].sort((a, b) =>
      String(a.memberName || '').localeCompare(String(b.memberName || ''), 'zh-TW'),
    );
  }, [ptContracts, studentQuery]);

  const memberContracts = useMemo(() => {
    if (selectedMemberId === '') return [];
    return ptContracts
      .filter((c) => c.memberId === selectedMemberId)
      .sort((a, b) => b.remainingSessions - a.remainingSessions);
  }, [ptContracts, selectedMemberId]);

  const selectedPt =
    contractId === ''
      ? null
      : memberContracts.find((c) => c.id === contractId) ||
        ptContracts.find((c) => c.id === contractId) ||
        null;

  // 選學員後自動帶入購買合約（剩堂最多）
  useEffect(() => {
    if (mode !== 'student') return;
    if (selectedMemberId === '') {
      setContractId('');
      return;
    }
    const list = ptContracts
      .filter((c) => c.memberId === selectedMemberId)
      .sort((a, b) => b.remainingSessions - a.remainingSessions);
    const preferred =
      list.find((c) => c.remainingSessions > 0) || list[0] || null;
    setContractId(preferred?.id ?? '');
  }, [mode, selectedMemberId, ptContracts]);

  const venue =
    venueId === '' ? null : venues.find((v) => v.id === venueId) || null;

  const venuesForStudent = useMemo(() => {
    if (mode !== 'student' || !selectedPt) return venues;
    return venues.filter((v) => privateVenueAllowed(selectedPt, v));
  }, [mode, selectedPt, venues]);

  const venueForForm =
    mode === 'student'
      ? venue && privateVenueAllowed(selectedPt, venue)
        ? venue
        : venuesForStudent[0] || null
      : venue;

  const stations = venueForForm?.stations || [];
  const effectiveStationId: number | '' =
    stations.length === 0
      ? ''
      : stationId !== '' && stations.some((s) => s.id === stationId)
        ? stationId
        : stations[0]?.id ?? '';

  // 預設場地（私教依購案分店＋HP/HR 共享過濾）
  useEffect(() => {
    const list = mode === 'student' ? venuesForStudent : venues;
    if (list.length === 0) return;
    if (venueId !== '' && list.some((v) => v.id === venueId)) return;
    setVenueId(list[0].id);
  }, [mode, venues, venuesForStudent, venueId]);

  const noSessions = Boolean(selectedPt && selectedPt.remainingSessions <= 0);
  const startIso = bookDate && bookTime ? toTaipeiIso(bookDate, bookTime) : null;
  const endIso = startIso ? addMinutesIso(startIso, durationMin) : null;

  const canBookStudent =
    Boolean(selectedPt && venueForForm && startIso && endIso && !bookBusy) &&
    !noSessions &&
    (stations.length === 0 || effectiveStationId !== '');

  const canBookGuest =
    Boolean(
      guestName.trim() &&
        guestPhone.trim() &&
        venue &&
        startIso &&
        endIso &&
        !bookBusy,
    ) && (stations.length === 0 || effectiveStationId !== '');

  function pickStudent(memberId: number) {
    setSelectedMemberId(memberId);
    onSelectClass(null);
  }

  function pickGuest(g: ConsultGuest) {
    setSelectedGuestId(g.id);
    setGuestName(g.name);
    setGuestPhone(g.phone);
    setGuestNote(g.note || '');
  }

  function resetScheduleFields() {
    setBookDate(todayYmd());
    setBookTime('');
    setDurationMin(DEFAULT_DURATION);
  }

  async function handleBookStudent(e: FormEvent) {
    e.preventDefault();
    if (!selectedPt || !venueForForm || !startIso || !endIso) {
      toast('請選擇學員、購買課程、場地與上課時間', 'error');
      return;
    }
    if (noSessions) {
      toast('此學員私教堂數已用罄，請引導至櫃檯續購', 'error');
      return;
    }
    if (stations.length > 0 && effectiveStationId === '') {
      toast('請選擇訓練站點', 'error');
      return;
    }
    setBookBusy(true);
    try {
      const result = await schedulePrivateSession({
        contractId: selectedPt.id,
        venueId: venueForForm.id,
        ...(effectiveStationId !== '' ? { stationId: Number(effectiveStationId) } : {}),
        startAt: startIso,
        endAt: endIso,
        ...(viewAsTrainerId ? { viewAsTrainerId } : {}),
      });
      const notify = (
        result.data as
          | { notify?: { ok?: boolean; skipped?: boolean; reason?: string | null } }
          | undefined
      )?.notify;
      setLastNotify({
        ok: Boolean(notify?.ok),
        skipped: Boolean(notify?.skipped),
        reason: notify?.reason || null,
        memberName: selectedPt.memberName || `會員 #${selectedPt.memberId}`,
        classTitle: '私教課',
      });
      toast(result.message || '預約成功', notify?.ok ? 'success' : 'info');
      setSelectedMemberId('');
      setContractId('');
      setStudentQuery('');
      resetScheduleFields();
      onSelectClass(null);
      await onBooked();
    } catch (err) {
      toast(getErrorMessage(err, '預約失敗'), 'error');
    } finally {
      setBookBusy(false);
    }
  }

  async function handleBookGuest(e: FormEvent) {
    e.preventDefault();
    if (!venue || !startIso || !endIso) {
      toast('請選擇場地與上課時間', 'error');
      return;
    }
    if (!guestName.trim() || !guestPhone.trim()) {
      toast('請輸入姓名與電話', 'error');
      return;
    }
    if (stations.length > 0 && effectiveStationId === '') {
      toast('請選擇訓練站點', 'error');
      return;
    }
    setBookBusy(true);
    try {
      const result = await scheduleConsultGuest({
        venueId: venue.id,
        ...(effectiveStationId !== '' ? { stationId: Number(effectiveStationId) } : {}),
        startAt: startIso,
        endAt: endIso,
        name: guestName.trim(),
        phone: guestPhone.trim(),
        note: guestNote.trim() || undefined,
        consultGuestId: selectedGuestId === '' ? undefined : selectedGuestId,
        ...(viewAsTrainerId ? { viewAsTrainerId } : {}),
      });
      const notify = (
        result.data as
          | { notify?: { ok?: boolean; skipped?: boolean; reason?: string | null } }
          | undefined
      )?.notify;
      setLastNotify({
        ok: Boolean(notify?.ok),
        skipped: Boolean(notify?.skipped),
        reason: notify?.reason || null,
        memberName: guestName.trim(),
        classTitle: '諮詢',
      });
      toast(result.message || '諮詢預約成功', notify?.ok ? 'success' : 'info');
      setGuestName('');
      setGuestPhone('');
      setGuestNote('');
      setSelectedGuestId('');
      resetScheduleFields();
      onSelectClass(null);
      await onBooked();
    } catch (err) {
      toast(getErrorMessage(err, '諮詢預約失敗'), 'error');
    } finally {
      setBookBusy(false);
    }
  }

  const scheduleVenueOptions = mode === 'student' ? venuesForStudent : venues;
  const scheduleVenue = mode === 'student' ? venueForForm : venue;

  const scheduleFields = (
    <>
      <Field
        label="場地"
        hint={
          mode === 'student'
            ? '依購買分店；HP↔HR 私教場地可互用'
            : '依教練可授課分店'
        }
      >
        <Select
          value={scheduleVenue ? String(scheduleVenue.id) : ''}
          onChange={(e) => {
            setVenueId(e.target.value ? Number(e.target.value) : '');
            setStationId('');
          }}
          required
        >
          <option value="">— 請選擇場地 —</option>
          {scheduleVenueOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {staffBranchLabel(v.branch)} · {v.name}
            </option>
          ))}
        </Select>
      </Field>

      {stations.length > 0 ? (
        <Field label="訓練站點">
          <Select
            value={effectiveStationId === '' ? '' : String(effectiveStationId)}
            onChange={(e) => setStationId(e.target.value ? Number(e.target.value) : '')}
            required
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label="上課日期">
        <Input
          type="date"
          value={bookDate}
          min={todayYmd()}
          onChange={(e) => setBookDate(e.target.value)}
          required
        />
      </Field>

      <Field label="上課時間" hint="開始時間（台北時間）">
        <Input
          type="time"
          value={bookTime}
          onChange={(e) => setBookTime(e.target.value)}
          required
        />
      </Field>

      <Field label="時長">
        <Select
          value={String(durationMin)}
          onChange={(e) => setDurationMin(Number(e.target.value) || DEFAULT_DURATION)}
        >
          {DURATION_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m} 分鐘
            </option>
          ))}
        </Select>
      </Field>
    </>
  );

  return (
    <div className="form-stack">
      {lastNotify ? (
        <Alert tone={lastNotify.ok ? 'success' : lastNotify.skipped ? 'warning' : 'error'}>
          <strong>約課通知</strong>
          <div className="text-sm" style={{ marginTop: 4 }}>
            {lastNotify.memberName}／{lastNotify.classTitle}：
            {lastNotify.ok
              ? '已透過 LINE 通知'
              : lastNotify.skipped
                ? `未推播（${lastNotify.reason || '未綁 LINE 或未設定'}）`
                : `LINE 通知失敗（${lastNotify.reason || '未知錯誤'}）`}
          </div>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setLastNotify(null)}>
              關閉
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="btn-row" role="tablist" aria-label="代約對象">
        <Button
          type="button"
          size="sm"
          variant={mode === 'student' ? 'primary' : 'ghost'}
          onClick={() => setMode('student')}
        >
          私教學員
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'consult' ? 'primary' : 'ghost'}
          onClick={() => setMode('consult')}
        >
          諮詢客人
        </Button>
      </div>

      {mode === 'student' ? (
        <Card title="代約私教" subtitle="自動帶入購買合約 · 自選上課日期／時間">
          <form onSubmit={handleBookStudent} className="form-stack">
            {ptContracts.length === 0 ? (
              <EmptyState
                icon="👥"
                title="尚無私教學員"
                desc="學員於櫃檯購買你的私教方案後會出現於此"
              />
            ) : (
              <>
                <Field label="搜尋學員" hint="姓名／電話／編號（僅自己的學生）">
                  <Input
                    value={studentQuery}
                    onChange={(e) => setStudentQuery(e.target.value)}
                    placeholder="輸入關鍵字篩選"
                  />
                </Field>

                <div className="coach-student-pick" role="listbox" aria-label="我的學員">
                  {filteredStudents.length === 0 ? (
                    <p className="text-sm text-muted">沒有符合的學員</p>
                  ) : (
                    filteredStudents.map((c) => {
                      const active = selectedMemberId === c.memberId;
                      return (
                        <button
                          key={c.memberId}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={`coach-student-pick__item ${active ? 'is-active' : ''}`}
                          onClick={() => pickStudent(c.memberId)}
                        >
                          <span className="coach-student-pick__name">
                            {c.memberName || `會員 #${c.memberId}`}
                            {c.isAlert ? <Badge tone="danger">警示</Badge> : null}
                          </span>
                          <span className="coach-student-pick__meta text-sm text-muted">
                            {c.memberPhone || '—'} · 剩 {c.remainingSessions}/{c.totalSessions} 堂
                            {c.hasLineBound ? ' · LINE' : ''}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}

            {selectedPt ? (
              <div className="coach-book-detail" aria-label="學員摘要">
                <div className="coach-book-detail__head">
                  <strong>{selectedPt.memberName || `會員 #${selectedPt.memberId}`}</strong>
                  <div className="btn-row" style={{ gap: 6 }}>
                    {selectedPt.hasLineBound ? (
                      <Badge tone="success">LINE 已綁</Badge>
                    ) : (
                      <Badge tone="warning">未綁 LINE</Badge>
                    )}
                    {selectedPt.isAlert ? <Badge tone="danger">警示</Badge> : null}
                  </div>
                </div>
                <dl className="coach-book-detail__grid">
                  <dt>會員編號</dt>
                  <dd className="mono">{selectedPt.memberNo || `#${selectedPt.memberId}`}</dd>
                  <dt>電話</dt>
                  <dd className="mono">{selectedPt.memberPhone || '—'}</dd>
                  <dt>會籍效期</dt>
                  <dd>{formatExpire(selectedPt.memberExpireDate)}</dd>
                  <dt>零錢包</dt>
                  <dd>{money(selectedPt.cashWallet)}</dd>
                  <dt>運動金</dt>
                  <dd>{money(selectedPt.bonusWallet)}</dd>
                  <dt>私教剩餘</dt>
                  <dd>
                    {selectedPt.remainingSessions}／{selectedPt.totalSessions} 堂
                  </dd>
                </dl>
                {noSessions ? (
                  <Alert tone="warning">堂數已用罄，無法代約；請引導學員至櫃檯續購。</Alert>
                ) : null}
                {selectedPt.isAlert ? (
                  <Alert tone="warning">此學員為警示帳號，請確認後再代約。</Alert>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelectedMemberId('');
                    setContractId('');
                    onSelectClass(null);
                  }}
                >
                  清除選取
                </Button>
              </div>
            ) : ptContracts.length > 0 ? (
              <Alert tone="info">請先搜尋並點選一位自己的學員，系統會自動帶入購買課程</Alert>
            ) : null}

            {selectedMemberId !== '' ? (
              <>
                <Field
                  label="購買課程"
                  hint={
                    memberContracts.length > 1
                      ? '此學員有多份合約，已自動帶入剩堂最多者'
                      : '已自動帶入進行中的私教合約'
                  }
                >
                  <Select
                    value={contractId === '' ? '' : String(contractId)}
                    onChange={(e) =>
                      setContractId(e.target.value ? Number(e.target.value) : '')
                    }
                    required
                    disabled={memberContracts.length === 0}
                  >
                    {memberContracts.length === 0 ? (
                      <option value="">— 無進行中合約 —</option>
                    ) : (
                      memberContracts.map((c) => (
                        <option key={c.id} value={c.id} disabled={c.remainingSessions <= 0}>
                          {contractLabel(c)}
                          {c.remainingSessions <= 0 ? '（已用罄）' : ''}
                        </option>
                      ))
                    )}
                  </Select>
                </Field>

                {scheduleFields}

                {venuesForStudent.length === 0 ? (
                  <Alert tone="warning">
                    此購案分店沒有可授課場地（或教練未綁定該店／HP↔HR 共享店）。
                  </Alert>
                ) : null}
              </>
            ) : null}

            {selectedPt && canBookStudent && startIso && endIso ? (
              <p className="coach-book-confirm text-sm">
                將為 <strong>{selectedPt.memberName || `會員 #${selectedPt.memberId}`}</strong>{' '}
                預約私教（{bookDate} {padTime(bookTime)} · {durationMin} 分）並扣 1 堂
                {selectedPt.hasLineBound
                  ? '，並自動 LINE 通知學員'
                  : '（學員未綁 LINE，無法推播）'}
              </p>
            ) : null}

            <Button type="submit" loading={bookBusy} disabled={!canBookStudent}>
              確認代約並通知
            </Button>
          </form>
        </Card>
      ) : (
        <Card
          title="諮詢客人代約"
          subtitle="輸入姓名＋電話 · 自選日期／時間 · 無需選擇課程"
        >
          <form onSubmit={handleBookGuest} className="form-stack">
            <Field label="搜尋既有客人" hint="可點選帶入姓名／電話">
              <Input
                value={guestQuery}
                onChange={(e) => setGuestQuery(e.target.value)}
                placeholder="姓名或電話"
              />
            </Field>

            {guests.length > 0 ? (
              <div className="coach-student-pick" role="listbox" aria-label="諮詢客人">
                {guests.map((g) => {
                  const active = selectedGuestId === g.id;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`coach-student-pick__item ${active ? 'is-active' : ''}`}
                      onClick={() => pickGuest(g)}
                    >
                      <span className="coach-student-pick__name">
                        {g.name}
                        {g.memberId ? <Badge tone="success">已是會員</Badge> : null}
                      </span>
                      <span className="coach-student-pick__meta text-sm text-muted mono">
                        {g.phone}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted">尚無紀錄，請直接輸入下方姓名與電話</p>
            )}

            <Field label="姓名" hint="必填">
              <Input
                value={guestName}
                onChange={(e) => {
                  setGuestName(e.target.value);
                  setSelectedGuestId('');
                }}
                placeholder="諮詢客人姓名"
                required
              />
            </Field>
            <Field label="電話" hint="必填 · 若已是會員會自動連結">
              <Input
                value={guestPhone}
                onChange={(e) => {
                  setGuestPhone(e.target.value);
                  setSelectedGuestId('');
                }}
                placeholder="09xxxxxxxx"
                inputMode="tel"
                required
              />
            </Field>
            <Field label="備註" hint="選填">
              <Input
                value={guestNote}
                onChange={(e) => setGuestNote(e.target.value)}
                placeholder="例如：想了解月卡／私教"
              />
            </Field>

            {scheduleFields}

            {venues.length === 0 ? (
              <Alert tone="warning">尚無可授課場地，請確認教練分店綁定。</Alert>
            ) : null}

            {canBookGuest && bookDate && bookTime ? (
              <p className="coach-book-confirm text-sm">
                將為 <strong>{guestName.trim()}</strong>（{guestPhone.trim()}）預約諮詢（
                {bookDate} {padTime(bookTime)} · {durationMin} 分）
              </p>
            ) : null}

            <Button type="submit" loading={bookBusy} disabled={!canBookGuest}>
              確認諮詢預約
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

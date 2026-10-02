import { Link, useLocation } from 'react-router-dom';
import { Alert } from '../ui';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { MY_ATTENDANCE_PATH } from '../../lib/staffPermissions';
import { dutyShiftLabel, hhmm } from '../../lib/hrFormat';

/** 員工後台頂部：班表值勤狀態（判定由後端；非值勤＝業務模組鎖定） */
export default function StaffDutyBanner() {
  const { duty } = useStaffAuth();
  const location = useLocation();
  if (!duty || duty.exempt || duty.state === 'CLOCKED_IN') return null;
  const onAttendancePage = location.pathname.startsWith(MY_ATTENDANCE_PATH);

  if (duty.state === 'IN_WINDOW') {
    return (
      <Alert tone="info">
        <strong>值勤班次：</strong>
        {duty.shift ? dutyShiftLabel(duty.shift) : '—'}，尚未打上班卡。
        {!onAttendancePage && (
          <>
            {' '}
            <Link to={`${MY_ATTENDANCE_PATH}?punch=1`}>前往打卡 →</Link>
          </>
        )}
      </Alert>
    );
  }

  const next = duty.nextShift;
  return (
    <Alert tone="warning">
      <strong>非值勤模式：</strong>
      {duty.message}。業務模組已鎖定，僅可使用我的出勤／請假／班表／通知。
      {next && (
        <div className="text-sm">
          下一班：{dutyShiftLabel(next)}（{hhmm(next.punchInOpensAt)} 起可打卡）
        </div>
      )}
    </Alert>
  );
}

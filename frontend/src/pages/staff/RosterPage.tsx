import CoachPlanReviewPanel from '../../components/staff/CoachPlanReviewPanel';
import ShiftRosterPanel from '../../components/staff/ShiftRosterPanel';
import { useStaffAuth } from '../../contexts/StaffAuthContext';
import { staffCanReviewWeekPlans } from '../../lib/staffPermissions';

/** 店長以上：本店（含隸屬分店）場務四週變形排班＋教練週班表審核（店長／FM；GM 無審核權）；範圍由後端依員工 JWT 限制 */
export default function RosterPage() {
  const { staff } = useStaffAuth();
  return (
    <div className="hq-dashboard">
      <ShiftRosterPanel />
      {staffCanReviewWeekPlans(staff) && <CoachPlanReviewPanel kind="COACH" />}
    </div>
  );
}

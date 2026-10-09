"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { LiveNotice, ListState, type Notice } from "./parts";
import { sendJson } from "@/components/auth/postJson";
import { useApi } from "./useApi";
import type { ClassGroupView } from "./model";
import { AttendanceStatus } from "@/lib/attendance/rules";
import type { StudentRollCallEntry } from "@/lib/attendance/service";

type StudentEntry = {
  studentId: string;
  admissionNo: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  status: AttendanceStatus;
  remarks: string;
};

type OverrideMap = Record<string, { status?: AttendanceStatus; remarks?: string }>;

export function AttendancePanel({ schoolCode, readOnly = false }: { schoolCode: string; readOnly?: boolean }) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [date, setDate] = useState(today);
  const [explicitArmId, setExplicitArmId] = useState<string>("");
  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, setSaving] = useState(false);

  // 1. Fetch Class Groups to get available arms
  const { reply: groupsReply, loading: groupsLoading } = useApi(
    `/api/v1/schools/${schoolCode}/academics/class-groups?limit=50&status=live`,
  );

  const armOptions = useMemo(() => {
    const groups = (groupsReply?.data?.classGroups as ClassGroupView[] | undefined) ?? [];
    const list: { id: string; label: string }[] = [];
    for (const g of groups) {
      for (const arm of g.arms) {
        list.push({
          id: arm.id,
          label: `${g.name} — ${arm.name}`,
        });
      }
    }
    return list;
  }, [groupsReply]);

  const selectedArmId = explicitArmId || (armOptions.length > 0 ? armOptions[0].id : "");

  // 2. Fetch Roll Call for the selected arm & date
  const rollCallUrl = selectedArmId ? `/api/v1/schools/${schoolCode}/academics/arms/${selectedArmId}/attendance?date=${date}` : null;

  const { reply: rollCallReply, loading: rollCallLoading, error: rollCallError, reload } = useApi(rollCallUrl);

  const canEditServer = Boolean(rollCallReply?.data?.canEdit);
  const isEditable = !readOnly && canEditServer && date <= today;

  const serverStudents = useMemo(() => {
    return (rollCallReply?.data?.students as StudentRollCallEntry[] | undefined) ?? [];
  }, [rollCallReply]);

  // Derived student entries combining server records with user's local edits
  const entries: StudentEntry[] = useMemo(() => {
    return serverStudents.map((s) => {
      const override = overrides[s.studentId];
      return {
        studentId: s.studentId,
        admissionNo: s.admissionNo,
        firstName: s.firstName,
        middleName: s.middleName,
        lastName: s.lastName,
        status: override?.status ?? s.status ?? AttendanceStatus.PRESENT,
        remarks: override?.remarks ?? s.remarks ?? "",
      };
    });
  }, [serverStudents, overrides]);

  // Summary computation
  const summary = useMemo(() => {
    const total = entries.length;
    let present = 0;
    let late = 0;
    let absent = 0;
    let excused = 0;

    for (const e of entries) {
      if (e.status === AttendanceStatus.PRESENT) present++;
      else if (e.status === AttendanceStatus.LATE) late++;
      else if (e.status === AttendanceStatus.ABSENT) absent++;
      else if (e.status === AttendanceStatus.EXCUSED) excused++;
    }

    const rate = total > 0 ? Math.round(((present + late) / total) * 100) : 0;
    return { total, present, late, absent, excused, rate };
  }, [entries]);

  // Date step helpers
  const stepDate = (days: number) => {
    const current = new Date(date);
    current.setDate(current.getDate() + days);
    const nextStr = current.toISOString().slice(0, 10);
    if (nextStr <= today) {
      setDate(nextStr);
      setOverrides({});
    }
  };

  const handleArmChange = (newArmId: string) => {
    setExplicitArmId(newArmId);
    setOverrides({});
  };

  const handleStatusChange = (studentId: string, status: AttendanceStatus) => {
    if (!isEditable) return;
    setOverrides((prev) => ({
      ...prev,
      [studentId]: {
        ...prev[studentId],
        status,
      },
    }));
  };

  const handleRemarksChange = (studentId: string, remarks: string) => {
    if (!isEditable) return;
    setOverrides((prev) => ({
      ...prev,
      [studentId]: {
        ...prev[studentId],
        remarks,
      },
    }));
  };

  const handleMarkAllPresent = () => {
    if (!isEditable) return;
    const nextOverrides: OverrideMap = { ...overrides };
    for (const e of entries) {
      if (e.status !== AttendanceStatus.EXCUSED) {
        nextOverrides[e.studentId] = {
          ...nextOverrides[e.studentId],
          status: AttendanceStatus.PRESENT,
        };
      }
    }
    setOverrides(nextOverrides);
  };

  const handleSave = async () => {
    if (!isEditable || !selectedArmId || entries.length === 0) return;
    setSaving(true);
    setNotice(null);

    const payload = {
      date,
      records: entries.map((e) => ({
        studentId: e.studentId,
        status: e.status,
        remarks: e.remarks.trim() || undefined,
      })),
    };

    const res = await sendJson(`/api/v1/schools/${schoolCode}/academics/arms/${selectedArmId}/attendance`, "POST", payload);

    setSaving(false);
    if (res.ok) {
      setNotice({
        variant: "success",
        text: `Attendance saved for ${date} (${entries.length} students recorded).`,
      });
      setOverrides({});
      await reload();
    } else {
      setNotice({
        variant: "error",
        text: res.message || "Failed to record attendance. Please check date or permissions.",
      });
    }
  };

  return (
    <section aria-labelledby="attendance-heading" className="space-y-6">
      <LiveNotice notice={notice} />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="attendance-heading" className="text-lg font-semibold tracking-tight text-fg">
            Daily Attendance
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Touch-optimised daily roll call with real-time statistics and 7-day edit grace period.
          </p>
        </div>

        {isEditable && entries.length > 0 && (
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={handleMarkAllPresent} disabled={saving} className="min-h-11">
              Mark All Present
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving} className="min-h-11 bg-brand text-white hover:bg-brand/90">
              {saving ? "Saving..." : "Save Roll Call"}
            </Button>
          </div>
        )}
      </div>

      {/* Control Bar: Arm Selector & Date Navigation */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 items-end bg-surface-1 p-4 rounded-xl border border-line">
        <div>
          <SelectField
            label="Class Arm"
            value={selectedArmId}
            onChange={(e) => handleArmChange(e.target.value)}
            disabled={groupsLoading || armOptions.length === 0}
            options={
              armOptions.length > 0
                ? armOptions.map((o) => ({ value: o.id, label: o.label }))
                : [{ value: "", label: groupsLoading ? "Loading arms..." : "No active arms found" }]
            }
          />
        </div>

        <div>
          <label htmlFor="attendance-date" className="block text-sm font-medium text-fg mb-1">
            Date
          </label>
          <input
            id="attendance-date"
            type="date"
            max={today}
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setDate(e.target.value);
                setOverrides({});
              }
            }}
            className="w-full rounded-md border border-line bg-surface-base px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>

        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => stepDate(-1)} aria-label="Previous day" className="min-h-11 flex-1">
            ← Prev Day
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDate(today);
              setOverrides({});
            }}
            disabled={date === today}
            className="min-h-11"
          >
            Today
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => stepDate(1)}
            disabled={date >= today}
            aria-label="Next day"
            className="min-h-11 flex-1"
          >
            Next Day →
          </Button>
        </div>

        <div className="text-right">
          {!isEditable && (
            <span className="inline-block text-xs font-semibold px-2.5 py-1.5 rounded-md bg-warn-bg text-warn-fg border border-warn-border">
              {readOnly ? "Read-Only Access" : date > today ? "Future Date" : "Edit Window Locked (> 7 days)"}
            </span>
          )}
        </div>
      </div>

      {/* Summary KPI Strip */}
      {entries.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="p-3 bg-surface-1 rounded-lg border border-line text-center">
            <div className="text-xs text-fg-muted uppercase tracking-wider font-semibold">Enrolled</div>
            <div className="text-2xl font-bold text-fg mt-1">{summary.total}</div>
          </div>
          <div className="p-3 bg-ok-bg/30 rounded-lg border border-ok-border text-center">
            <div className="text-xs text-ok-fg uppercase tracking-wider font-semibold">Present</div>
            <div className="text-2xl font-bold text-ok-fg mt-1">{summary.present}</div>
          </div>
          <div className="p-3 bg-warn-bg/30 rounded-lg border border-warn-border text-center">
            <div className="text-xs text-warn-fg uppercase tracking-wider font-semibold">Late</div>
            <div className="text-2xl font-bold text-warn-fg mt-1">{summary.late}</div>
          </div>
          <div className="p-3 bg-danger-bg/30 rounded-lg border border-danger-border text-center">
            <div className="text-xs text-danger-fg uppercase tracking-wider font-semibold">Absent</div>
            <div className="text-2xl font-bold text-danger-fg mt-1">{summary.absent}</div>
          </div>
          <div className="p-3 bg-info-bg/30 rounded-lg border border-info-border text-center">
            <div className="text-xs text-info-fg uppercase tracking-wider font-semibold">Excused</div>
            <div className="text-2xl font-bold text-info-fg mt-1">{summary.excused}</div>
          </div>
          <div className="p-3 bg-surface-2 rounded-lg border border-line text-center">
            <div className="text-xs text-fg-muted uppercase tracking-wider font-semibold">Rate</div>
            <div className="text-2xl font-bold text-fg mt-1">{summary.rate}%</div>
          </div>
        </div>
      )}

      {/* Roster Touch Grid */}
      <ListState
        loading={rollCallLoading || groupsLoading}
        error={rollCallError}
        empty={Boolean(selectedArmId && !rollCallLoading && entries.length === 0)}
        emptyText={
          selectedArmId ? "No active students enrolled in this class arm for the current session." : "Select a class arm to view roll call."
        }
        onRetry={() => void reload()}
      >
        <div className="space-y-3">
          {entries.map((student, idx) => {
            return (
              <div
                key={student.studentId}
                className="flex flex-col md:flex-row items-start md:items-center justify-between p-4 bg-surface-1 rounded-xl border border-line gap-4 transition-colors hover:border-brand/40"
              >
                {/* Student Info */}
                <div className="min-w-50 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold text-fg-muted">#{idx + 1}</span>
                    <span className="font-semibold text-fg">
                      {student.lastName}, {student.firstName} {student.middleName ?? ""}
                    </span>
                  </div>
                  <div className="text-xs font-mono text-fg-muted mt-0.5">Admission: {student.admissionNo}</div>
                </div>

                {/* Touch Segment Controls (>= 44px touch targets) */}
                <div className="flex flex-wrap items-center gap-1.5 w-full md:w-auto">
                  <button
                    type="button"
                    disabled={!isEditable}
                    onClick={() => handleStatusChange(student.studentId, AttendanceStatus.PRESENT)}
                    className={`min-h-11 min-w-17.5 px-3 py-2 text-xs font-bold rounded-lg transition-all ${
                      student.status === AttendanceStatus.PRESENT
                        ? "bg-green-600 text-white shadow-sm ring-2 ring-green-500/50"
                        : "bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg"
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    PRESENT
                  </button>

                  <button
                    type="button"
                    disabled={!isEditable}
                    onClick={() => handleStatusChange(student.studentId, AttendanceStatus.LATE)}
                    className={`min-h-11 min-w-17.5 px-3 py-2 text-xs font-bold rounded-lg transition-all ${
                      student.status === AttendanceStatus.LATE
                        ? "bg-amber-600 text-white shadow-sm ring-2 ring-amber-500/50"
                        : "bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg"
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    LATE
                  </button>

                  <button
                    type="button"
                    disabled={!isEditable}
                    onClick={() => handleStatusChange(student.studentId, AttendanceStatus.ABSENT)}
                    className={`min-h-11 min-w-17.5 px-3 py-2 text-xs font-bold rounded-lg transition-all ${
                      student.status === AttendanceStatus.ABSENT
                        ? "bg-rose-600 text-white shadow-sm ring-2 ring-rose-500/50"
                        : "bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg"
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    ABSENT
                  </button>

                  <button
                    type="button"
                    disabled={!isEditable}
                    onClick={() => handleStatusChange(student.studentId, AttendanceStatus.EXCUSED)}
                    className={`min-h-11 min-w-17.5 px-3 py-2 text-xs font-bold rounded-lg transition-all ${
                      student.status === AttendanceStatus.EXCUSED
                        ? "bg-sky-600 text-white shadow-sm ring-2 ring-sky-500/50"
                        : "bg-surface-2 text-fg-muted hover:bg-surface-3 hover:text-fg"
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    EXCUSED
                  </button>
                </div>

                {/* Inline Remarks Input */}
                <div className="w-full md:w-64">
                  <input
                    type="text"
                    disabled={!isEditable}
                    placeholder="Remarks (e.g. sick note)..."
                    value={student.remarks}
                    onChange={(e) => handleRemarksChange(student.studentId, e.target.value)}
                    maxLength={500}
                    className="w-full text-xs rounded-lg border border-line bg-surface-base px-3 py-2 text-fg placeholder:text-fg-muted/60 focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </ListState>

      {/* Floating Save Bar for long lists on mobile/desktop */}
      {isEditable && entries.length > 5 && (
        <div className="sticky bottom-4 z-10 flex justify-end p-3 bg-surface-base/90 backdrop-blur border border-line rounded-xl shadow-lg">
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="min-h-11 px-6 bg-brand text-white hover:bg-brand/90 font-semibold"
          >
            {saving ? "Saving..." : "Save Roll Call"}
          </Button>
        </div>
      )}
    </section>
  );
}

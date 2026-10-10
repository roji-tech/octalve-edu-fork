"use client";

import { useState, useId } from "react";
import { DAYS_OF_WEEK, getDayName, isValidTimeRange, findSlotClashes, type TimetableClash } from "@/lib/timetable/rules";
import type { TimetableSlotDto } from "@/lib/timetable/service";

export interface SlotEditModalProps {
  schoolCode: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  initialSlot?: TimetableSlotDto | null;
  initialDay?: number;
  existingSlots: TimetableSlotDto[];
  classArms: { id: string; name: string }[];
  subjects: { id: string; name: string; code?: string | null }[];
  teachers: { id: string; name: string }[];
}

export function SlotEditModal({
  schoolCode,
  isOpen,
  onClose,
  onSaved,
  initialSlot,
  initialDay,
  existingSlots,
  classArms,
  subjects,
  teachers,
}: SlotEditModalProps) {
  const formId = useId();
  const [dayOfWeek, setDayOfWeek] = useState<number>(initialSlot?.dayOfWeek ?? initialDay ?? 1);
  const [classArmId, setClassArmId] = useState<string>(initialSlot?.classArmId ?? classArms[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState<string>(initialSlot?.subjectId ?? subjects[0]?.id ?? "");
  const [staffRecordId, setStaffRecordId] = useState<string>(initialSlot?.staffRecordId ?? teachers[0]?.id ?? "");
  const [startTime, setStartTime] = useState<string>(initialSlot?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState<string>(initialSlot?.endTime ?? "09:00");
  const [periodNumber, setPeriodNumber] = useState<string>(initialSlot?.periodNumber ? String(initialSlot.periodNumber) : "");
  const [room, setRoom] = useState<string>(initialSlot?.room ?? "");

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Real-time live clash preview
  const candidate = {
    id: initialSlot?.id,
    dayOfWeek,
    classArmId,
    subjectId,
    staffRecordId,
    startTime,
    endTime,
    room: room.trim() || null,
  };

  const isRangeValid = isValidTimeRange(startTime, endTime);
  const clashes: TimetableClash[] = isRangeValid
    ? findSlotClashes(
        candidate,
        existingSlots.map((s) => ({
          id: s.id,
          dayOfWeek: s.dayOfWeek,
          classArmId: s.classArmId,
          subjectId: s.subjectId,
          staffRecordId: s.staffRecordId,
          startTime: s.startTime,
          endTime: s.endTime,
          room: s.room,
        })),
      )
    : [];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isRangeValid) {
      setError("Start time must be strictly before end time.");
      return;
    }
    if (clashes.length > 0) {
      setError(`Cannot save: ${clashes[0].message}`);
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      classArmId,
      subjectId,
      staffRecordId,
      dayOfWeek,
      startTime,
      endTime,
      periodNumber: periodNumber ? Number(periodNumber) : null,
      room: room.trim() || null,
    };

    try {
      const url = initialSlot ? `/api/v1/schools/${schoolCode}/timetable/${initialSlot.id}` : `/api/v1/schools/${schoolCode}/timetable`;
      const method = initialSlot ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to save timetable slot.");
      }

      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error saving slot.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!initialSlot) return;
    if (!confirm("Are you sure you want to remove this timetable slot?")) return;

    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/timetable/${initialSlot.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error?.message || "Failed to delete slot.");
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error deleting slot.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line pb-4">
          <h2 className="text-lg font-semibold text-fg">{initialSlot ? "Edit Timetable Slot" : "Schedule New Lesson Slot"}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-fg-muted hover:bg-surface-2 hover:text-fg"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {error && <div className="mt-4 rounded-xl border border-danger-line bg-danger-bg p-3 text-sm text-danger-text">{error}</div>}

        {/* Live Clash Warning Alert */}
        {clashes.length > 0 && (
          <div className="mt-4 rounded-xl border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg">
            <div className="flex items-center gap-2 font-semibold">
              <span aria-hidden="true">⚠️</span> Conflict Detected ({clashes[0].type})
            </div>
            <p className="mt-1 text-xs opacity-90">{clashes[0].message}</p>
          </div>
        )}

        <form id={formId} onSubmit={handleSave} className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted">Day of Week</label>
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              >
                {DAYS_OF_WEEK.map((day) => (
                  <option key={day} value={day}>
                    {getDayName(day)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-fg-muted">Class Arm</label>
              <select
                value={classArmId}
                onChange={(e) => setClassArmId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
                required
              >
                {classArms.map((arm) => (
                  <option key={arm.id} value={arm.id}>
                    {arm.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted">Subject</label>
              <select
                value={subjectId}
                onChange={(e) => setSubjectId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
                required
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.code ? `(${s.code})` : ""}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-fg-muted">Teacher</label>
              <select
                value={staffRecordId}
                onChange={(e) => setStaffRecordId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
                required
              >
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted">Start Time (HH:MM)</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-muted">End Time (HH:MM)</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted">Period # (optional)</label>
              <input
                type="number"
                min={1}
                max={20}
                value={periodNumber}
                onChange={(e) => setPeriodNumber(e.target.value)}
                placeholder="e.g. 1"
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-muted">Room / Venue (optional)</label>
              <input
                type="text"
                maxLength={50}
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                placeholder="e.g. Science Lab 2"
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
            {initialSlot ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || saving}
                className="rounded-xl border border-danger-line px-4 py-2 text-xs font-medium text-danger-text hover:bg-danger-bg disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete Slot"}
              </button>
            ) : (
              <div />
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-line px-4 py-2 text-xs font-medium text-fg hover:bg-surface-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || deleting || clashes.length > 0}
                className="rounded-xl bg-brand-strong px-4 py-2 text-xs font-medium text-white hover:bg-brand-strong-hover disabled:opacity-50"
              >
                {saving ? "Saving..." : initialSlot ? "Update Slot" : "Schedule Slot"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

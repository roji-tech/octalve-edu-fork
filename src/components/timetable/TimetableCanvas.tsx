"use client";

import { useState } from "react";
import { getDayName, getShortDayName, findSlotClashes, type TimetableSlotInput } from "@/lib/timetable/rules";
import type { TimetableSlotDto } from "@/lib/timetable/service";
import { SlotEditModal } from "./SlotEditModal";

export interface TimetableCanvasProps {
  schoolCode: string;
  slots: TimetableSlotDto[];
  classArms: { id: string; name: string }[];
  subjects: { id: string; name: string; code?: string | null }[];
  teachers: { id: string; name: string }[];
  readOnly?: boolean;
  onRefresh: () => void;
}

export function TimetableCanvas({ schoolCode, slots, classArms, subjects, teachers, readOnly = false, onRefresh }: TimetableCanvasProps) {
  const [selectedArmId, setSelectedArmId] = useState<string>("ALL");
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("ALL");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingSlot, setEditingSlot] = useState<TimetableSlotDto | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | undefined>(undefined);

  // Pre-calculate clashes in current dataset for visual badge highlighting
  const clashSlotIds = new Set<string>();
  const slotInputs: TimetableSlotInput[] = slots.map((s) => ({
    id: s.id,
    dayOfWeek: s.dayOfWeek,
    classArmId: s.classArmId,
    subjectId: s.subjectId,
    staffRecordId: s.staffRecordId,
    startTime: s.startTime,
    endTime: s.endTime,
    room: s.room,
  }));

  for (const s of slotInputs) {
    const clashes = findSlotClashes(s, slotInputs);
    if (clashes.length > 0) {
      if (s.id) clashSlotIds.add(s.id);
    }
  }

  // Filter slots
  const filteredSlots = slots.filter((slot) => {
    if (selectedArmId !== "ALL" && slot.classArmId !== selectedArmId) return false;
    if (selectedTeacherId !== "ALL" && slot.staffRecordId !== selectedTeacherId) return false;
    return true;
  });

  // Group filtered slots by day (1 to 5 weekdays or 1 to 6)
  const daysToShow = [1, 2, 3, 4, 5]; // Mon to Fri default
  const hasWeekend = filteredSlots.some((s) => s.dayOfWeek === 6 || s.dayOfWeek === 7);
  const activeDays = hasWeekend ? [1, 2, 3, 4, 5, 6] : daysToShow;

  const handleOpenAdd = (day?: number) => {
    if (readOnly) return;
    setSelectedDay(day);
    setEditingSlot(null);
    setModalOpen(true);
  };

  const handleEdit = (slot: TimetableSlotDto) => {
    if (readOnly) return;
    setEditingSlot(slot);
    setModalOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Top Filter and Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="sr-only">Filter by Class Arm</label>
            <select
              value={selectedArmId}
              onChange={(e) => setSelectedArmId(e.target.value)}
              className="rounded-xl border border-line bg-field px-3 py-2 text-xs font-medium text-fg"
            >
              <option value="ALL">All Class Arms</option>
              {classArms.map((arm) => (
                <option key={arm.id} value={arm.id}>
                  {arm.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="sr-only">Filter by Teacher</label>
            <select
              value={selectedTeacherId}
              onChange={(e) => setSelectedTeacherId(e.target.value)}
              className="rounded-xl border border-line bg-field px-3 py-2 text-xs font-medium text-fg"
            >
              <option value="ALL">All Teachers</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center rounded-xl border border-line bg-field p-1 text-xs">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`rounded-lg px-2.5 py-1 font-medium transition ${
                viewMode === "grid" ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg"
              }`}
            >
              Week Grid
            </button>
            <button
              type="button"
              onClick={() => setViewMode("list")}
              className={`rounded-lg px-2.5 py-1 font-medium transition ${
                viewMode === "list" ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg"
              }`}
            >
              Card View
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!readOnly && (
            <button
              type="button"
              onClick={() => handleOpenAdd()}
              className="flex items-center gap-1.5 rounded-xl bg-brand-strong px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-brand-strong-hover transition"
            >
              <span aria-hidden="true">+</span> Schedule Slot
            </button>
          )}
        </div>
      </div>

      {/* Clash Notification Banner if any exists in current view */}
      {clashSlotIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-2xl border border-danger-line bg-danger-bg p-4 text-xs text-danger-text">
          <span className="text-base" aria-hidden="true">
            ⚠️
          </span>
          <div>
            <span className="font-semibold">Schedule Conflict Detected:</span> One or more timetable slots have overlapping teacher, class
            arm, or room bookings. Conflicting slots are highlighted in red below.
          </div>
        </div>
      )}

      {/* Visual Canvas View */}
      {viewMode === "grid" ? (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <div
            className="grid min-w-187.5 grid-cols-5 gap-3"
            style={{ gridTemplateColumns: `repeat(${activeDays.length}, minmax(0, 1fr))` }}
          >
            {activeDays.map((day) => {
              const daySlots = filteredSlots.filter((s) => s.dayOfWeek === day).sort((a, b) => a.startTime.localeCompare(b.startTime));

              return (
                <div key={day} className="flex flex-col rounded-xl border border-line bg-field/40 p-3 min-h-90">
                  {/* Day Header */}
                  <div className="flex items-center justify-between border-b border-line pb-2 mb-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-fg">{getDayName(day)}</span>
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-fg-muted">{daySlots.length}</span>
                  </div>

                  {/* Day Slots Stack */}
                  <div className="flex-1 space-y-2">
                    {daySlots.length === 0 ? (
                      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-line text-[11px] text-fg-muted">
                        No slots
                      </div>
                    ) : (
                      daySlots.map((slot) => {
                        const hasClash = clashSlotIds.has(slot.id);
                        return (
                          <div
                            key={slot.id}
                            onClick={() => handleEdit(slot)}
                            className={`group relative rounded-xl border p-3 text-left transition ${
                              hasClash
                                ? "border-danger-line bg-danger-bg/60 text-danger-fg shadow-xs"
                                : "border-line bg-surface hover:border-line-strong hover:bg-surface-2 text-fg shadow-xs"
                            } ${!readOnly ? "cursor-pointer" : ""}`}
                          >
                            {hasClash && (
                              <div className="mb-1 inline-flex items-center gap-1 rounded bg-danger-line px-1.5 py-0.5 text-[10px] font-bold text-danger-text">
                                ! Conflict
                              </div>
                            )}

                            <div className="flex items-baseline justify-between text-xs font-semibold">
                              <span>{slot.subjectName}</span>
                              {slot.periodNumber && <span className="text-[10px] text-fg-muted font-normal">P{slot.periodNumber}</span>}
                            </div>

                            <div className="mt-1 flex items-center justify-between text-[11px] text-fg-muted">
                              <span>
                                {slot.startTime} – {slot.endTime}
                              </span>
                              {slot.room && (
                                <span className="rounded bg-field px-1.5 py-0.5 text-[10px] font-medium text-fg">{slot.room}</span>
                              )}
                            </div>

                            <div className="mt-2 flex items-center justify-between border-t border-line/60 pt-1.5 text-[10px]">
                              <span className="font-medium text-brand-fg truncate max-w-22.5">{slot.classArmName}</span>
                              <span className="text-fg-muted truncate max-w-22.5">{slot.teacherName}</span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => handleOpenAdd(day)}
                      className="mt-3 w-full rounded-lg border border-dashed border-line py-1.5 text-center text-[11px] text-fg-muted hover:border-line-strong hover:text-fg"
                    >
                      + Add to {getShortDayName(day)}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* Mobile Card List View */
        <div className="space-y-4">
          {activeDays.map((day) => {
            const daySlots = filteredSlots.filter((s) => s.dayOfWeek === day).sort((a, b) => a.startTime.localeCompare(b.startTime));

            return (
              <div key={day} className="rounded-2xl border border-line bg-surface p-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-line pb-2 mb-3">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-fg">{getDayName(day)}</h3>
                  <span className="text-xs text-fg-muted">{daySlots.length} lessons</span>
                </div>

                {daySlots.length === 0 ? (
                  <p className="py-4 text-center text-xs text-fg-muted">No scheduled slots for this day.</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {daySlots.map((slot) => {
                      const hasClash = clashSlotIds.has(slot.id);
                      return (
                        <div
                          key={slot.id}
                          onClick={() => handleEdit(slot)}
                          className={`rounded-xl border p-4 text-left transition ${
                            hasClash
                              ? "border-danger-line bg-danger-bg text-danger-fg"
                              : "border-line bg-surface-2/60 text-fg hover:border-line-strong"
                          } ${!readOnly ? "cursor-pointer" : ""}`}
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="text-sm font-semibold">{slot.subjectName}</div>
                              <div className="text-xs text-fg-muted">
                                {slot.classArmName} · {slot.classGroupName}
                              </div>
                            </div>
                            <span className="rounded-lg bg-field px-2 py-0.5 text-xs font-mono font-medium">
                              {slot.startTime} - {slot.endTime}
                            </span>
                          </div>

                          <div className="mt-3 flex items-center justify-between text-xs text-fg-muted">
                            <span>
                              Teacher: <strong className="text-fg font-medium">{slot.teacherName}</strong>
                            </span>
                            {slot.room && (
                              <span>
                                Room: <strong className="text-fg font-medium">{slot.room}</strong>
                              </span>
                            )}
                          </div>

                          {hasClash && <div className="mt-2 text-[11px] font-semibold text-danger-text">⚠️ Schedule conflict detected</div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit / Create Modal */}
      <SlotEditModal
        schoolCode={schoolCode}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={onRefresh}
        initialSlot={editingSlot}
        initialDay={selectedDay}
        existingSlots={slots}
        classArms={classArms}
        subjects={subjects}
        teachers={teachers}
      />
    </div>
  );
}

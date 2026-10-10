"use client";

import { useMemo } from "react";
import type { TimetableSlotDto } from "@/lib/timetable/service";
import { TimetableCanvas } from "@/components/timetable/TimetableCanvas";
import { useApi } from "@/components/academics/useApi";

export interface TimetablePanelProps {
  schoolCode: string;
  readOnly?: boolean;
}

export function TimetablePanel({ schoolCode, readOnly = false }: TimetablePanelProps) {
  const {
    reply: timetableReply,
    loading: timetableLoading,
    error: timetableError,
    reload,
  } = useApi(`/api/v1/schools/${schoolCode}/timetable`);
  const { reply: classesReply } = useApi(`/api/v1/schools/${schoolCode}/academics/classes`);
  const { reply: subjectsReply } = useApi(`/api/v1/schools/${schoolCode}/academics/subjects`);
  const { reply: staffReply } = useApi(`/api/v1/schools/${schoolCode}/people/staff`);

  const slots = useMemo<TimetableSlotDto[]>(() => {
    return (timetableReply?.data?.slots as TimetableSlotDto[] | undefined) ?? [];
  }, [timetableReply]);

  const classArms = useMemo(() => {
    const list: { id: string; name: string }[] = [];
    const groups = (classesReply?.data?.groups as { name: string; arms: { id: string; name: string }[] }[] | undefined) ?? [];
    for (const group of groups) {
      for (const arm of group.arms || []) {
        list.push({ id: arm.id, name: `${group.name} ${arm.name}` });
      }
    }
    return list;
  }, [classesReply]);

  const subjects = useMemo(() => {
    return (subjectsReply?.data?.subjects as { id: string; name: string; code?: string | null }[] | undefined) ?? [];
  }, [subjectsReply]);

  const teachers = useMemo(() => {
    const items = (staffReply?.data?.items as { id: string; user?: { name?: string; email?: string } }[] | undefined) ?? [];
    return items.map((s) => ({
      id: s.id,
      name: s.user?.name || s.user?.email || "Teacher",
    }));
  }, [staffReply]);

  if (timetableLoading) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-line bg-surface p-8 text-sm text-fg-muted">
        Loading timetable schedule...
      </div>
    );
  }

  if (timetableError) {
    return (
      <div className="rounded-2xl border border-danger-line bg-danger-bg p-6 text-sm text-danger-text">
        <p className="font-semibold">Unable to load timetable</p>
        <p className="mt-1">{timetableError}</p>
        <button
          type="button"
          onClick={() => reload()}
          className="mt-4 rounded-xl bg-surface px-4 py-2 text-xs font-medium text-fg shadow-xs hover:bg-surface-2"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-fg">Weekly Timetable Schedule</h2>
          <p className="text-sm text-fg-muted">Manage periods, subjects, rooms, and teacher schedules with automated clash prevention.</p>
        </div>
      </div>

      <TimetableCanvas
        schoolCode={schoolCode}
        slots={slots}
        classArms={classArms}
        subjects={subjects}
        teachers={teachers}
        readOnly={readOnly}
        onRefresh={() => reload()}
      />
    </div>
  );
}

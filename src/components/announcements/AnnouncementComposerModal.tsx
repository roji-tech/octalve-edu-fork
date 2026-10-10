"use client";

import { useState } from "react";
import { Role, AnnouncementStatus } from "@prisma/client";
import type { AnnouncementDto } from "@/lib/announcements/service";

export interface AnnouncementComposerModalProps {
  schoolCode: string;
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  initialAnnouncement?: AnnouncementDto | null;
  campuses: { id: string; name: string }[];
  classArms: { id: string; name: string }[];
}

const TARGETABLE_ROLES: { role: Role; label: string }[] = [
  { role: Role.STUDENT, label: "Students" },
  { role: Role.PARENT, label: "Parents" },
  { role: Role.TEACHING_STAFF, label: "Teachers" },
  { role: Role.NON_TEACHING_STAFF, label: "Non-teaching Staff" },
  { role: Role.ADMIN, label: "Administrators" },
];

export function AnnouncementComposerModal({
  schoolCode,
  isOpen,
  onClose,
  onSaved,
  initialAnnouncement,
  campuses,
  classArms,
}: AnnouncementComposerModalProps) {
  const [title, setTitle] = useState(initialAnnouncement?.title ?? "");
  const [body, setBody] = useState(initialAnnouncement?.body ?? "");
  const [targetRoles, setTargetRoles] = useState<Role[]>(initialAnnouncement?.targetRoles ?? []);
  const [campusId, setCampusId] = useState<string>(initialAnnouncement?.campusId ?? "");
  const [classArmId, setClassArmId] = useState<string>(initialAnnouncement?.classArmId ?? "");
  const [status, setStatus] = useState<AnnouncementStatus>(initialAnnouncement?.status ?? AnnouncementStatus.PUBLISHED);
  const [isPinned, setIsPinned] = useState<boolean>(initialAnnouncement?.isPinned ?? false);
  const [expiresAt, setExpiresAt] = useState<string>(initialAnnouncement?.expiresAt ? initialAnnouncement.expiresAt.slice(0, 10) : "");

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const toggleRole = (role: Role) => {
    setTargetRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) {
      setError("Please provide both a title and content body.");
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      title: title.trim(),
      body: body.trim(),
      targetRoles,
      campusId: campusId || null,
      classArmId: classArmId || null,
      status,
      isPinned,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };

    try {
      const url = initialAnnouncement
        ? `/api/v1/schools/${schoolCode}/announcements/${initialAnnouncement.id}`
        : `/api/v1/schools/${schoolCode}/announcements`;
      const method = initialAnnouncement ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to save announcement.");
      }

      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error saving announcement.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!initialAnnouncement) return;
    if (!confirm("Are you sure you want to delete this announcement?")) return;

    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/announcements/${initialAnnouncement.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error?.message || "Failed to delete announcement.");
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error deleting announcement.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line pb-4">
          <h2 className="text-lg font-semibold text-fg">{initialAnnouncement ? "Edit Announcement" : "Create Broadcast Notice"}</h2>
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

        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-fg-muted">Announcement Title</label>
            <input
              type="text"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. End of Term Examination Schedule Released"
              className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-muted">Notice Content</label>
            <textarea
              required
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Enter the full message for students, parents, or staff..."
              className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1.5">Target Audience Roles (Empty = School-wide Broadcast)</label>
            <div className="flex flex-wrap gap-2">
              {TARGETABLE_ROLES.map(({ role, label }) => {
                const checked = targetRoles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleRole(role)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      checked ? "bg-brand-strong text-white shadow-xs" : "border border-line bg-field text-fg-muted hover:text-fg"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted">Campus (Optional)</label>
              <select
                value={campusId}
                onChange={(e) => setCampusId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              >
                <option value="">All Campuses</option>
                {campuses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-fg-muted">Class Arm (Optional)</label>
              <select
                value={classArmId}
                onChange={(e) => setClassArmId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              >
                <option value="">All Class Arms</option>
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
              <label className="block text-xs font-medium text-fg-muted">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as AnnouncementStatus)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              >
                <option value={AnnouncementStatus.PUBLISHED}>Published</option>
                <option value={AnnouncementStatus.DRAFT}>Draft</option>
                <option value={AnnouncementStatus.ARCHIVED}>Archived</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-fg-muted">Expires On (Optional)</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-field px-3 py-2 text-sm text-fg"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="isPinnedCheck"
              checked={isPinned}
              onChange={(e) => setIsPinned(e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            <label htmlFor="isPinnedCheck" className="text-xs font-medium text-fg">
              Pin to top of school feed
            </label>
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-line pt-4">
            {initialAnnouncement ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || saving}
                className="rounded-xl border border-danger-line px-4 py-2 text-xs font-medium text-danger-text hover:bg-danger-bg disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete Notice"}
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
                disabled={saving || deleting}
                className="rounded-xl bg-brand-strong px-4 py-2 text-xs font-medium text-white hover:bg-brand-strong-hover disabled:opacity-50"
              >
                {saving ? "Saving..." : initialAnnouncement ? "Update Notice" : "Broadcast Notice"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

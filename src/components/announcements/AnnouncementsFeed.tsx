"use client";

import { useMemo, useState } from "react";
import { Role } from "@prisma/client";
import type { AnnouncementDto } from "@/lib/announcements/service";
import { AnnouncementComposerModal } from "./AnnouncementComposerModal";
import { useApi } from "@/components/academics/useApi";

export interface AnnouncementsFeedProps {
  schoolCode: string;
  userRole: Role;
  userId: string;
  campuses: { id: string; name: string }[];
}

export function AnnouncementsFeed({ schoolCode, userRole, userId, campuses }: AnnouncementsFeedProps) {
  const canAuthor = userRole === Role.ADMIN || userRole === Role.TEACHING_STAFF;

  const { reply, loading, error, reload } = useApi(`/api/v1/schools/${schoolCode}/announcements`);
  const { reply: classesReply } = useApi(canAuthor ? `/api/v1/schools/${schoolCode}/academics/classes` : null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<AnnouncementDto | null>(null);

  const announcements = useMemo<AnnouncementDto[]>(() => {
    return (reply?.data?.items as AnnouncementDto[] | undefined) ?? [];
  }, [reply]);

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

  const handleEdit = (item: AnnouncementDto) => {
    const canEdit = userRole === Role.ADMIN || item.authorUserId === userId;
    if (!canEdit) return;
    setEditingAnnouncement(item);
    setComposerOpen(true);
  };

  const handleCreate = () => {
    setEditingAnnouncement(null);
    setComposerOpen(true);
  };

  return (
    <section aria-labelledby="announcements-heading" className="mt-10">
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <h3 id="announcements-heading" className="text-sm font-semibold tracking-wider text-fg-muted uppercase">
            Announcements & School Notices
          </h3>
          <p className="mt-0.5 text-xs text-fg-muted">Important updates, events, and bulletins from school administration.</p>
        </div>

        {canAuthor && (
          <button
            type="button"
            onClick={handleCreate}
            className="flex items-center gap-1.5 rounded-xl bg-brand-strong px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-brand-strong-hover transition"
          >
            <span aria-hidden="true">+</span> New Notice
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-8 text-center text-xs text-fg-muted">Loading notices...</div>
      ) : error ? (
        <div className="mt-4 rounded-xl border border-danger-line bg-danger-bg p-4 text-xs text-danger-text">{error}</div>
      ) : announcements.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-line p-8 text-center text-xs text-fg-muted">
          No announcements published yet.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {announcements.map((item) => {
            const canManage = userRole === Role.ADMIN || item.authorUserId === userId;
            const isDraft = item.status === "DRAFT";

            return (
              <article
                key={item.id}
                className={`group relative rounded-2xl border p-5 transition ${
                  item.isPinned
                    ? "border-brand/40 bg-surface shadow-xs ring-1 ring-brand/20"
                    : isDraft
                      ? "border-dashed border-line-strong bg-field/40"
                      : "border-line bg-surface hover:border-line-strong"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {item.isPinned && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-tint px-2.5 py-0.5 text-[10px] font-semibold text-brand-fg">
                        📌 Pinned Notice
                      </span>
                    )}

                    {isDraft && <span className="rounded-full bg-warn-bg px-2.5 py-0.5 text-[10px] font-semibold text-warn-fg">Draft</span>}

                    {item.targetRoles.length === 0 ? (
                      <span className="rounded-full bg-field px-2.5 py-0.5 text-[10px] font-medium text-fg-muted">School-wide</span>
                    ) : (
                      item.targetRoles.map((r) => (
                        <span key={r} className="rounded-full bg-field px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                          {r}
                        </span>
                      ))
                    )}

                    {item.campusName && (
                      <span className="rounded-full bg-field px-2 py-0.5 text-[10px] font-medium text-fg-muted">📍 {item.campusName}</span>
                    )}

                    {item.classArmName && (
                      <span className="rounded-full bg-field px-2 py-0.5 text-[10px] font-medium text-fg-muted">
                        👥 {item.classArmName}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <time dateTime={item.publishedAt}>
                      {new Date(item.publishedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </time>

                    {canManage && (
                      <button
                        type="button"
                        onClick={() => handleEdit(item)}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-brand-fg hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>

                <h4 className="mt-2 text-base font-bold tracking-tight text-fg">{item.title}</h4>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-2 whitespace-pre-line">{item.body}</p>

                <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-[11px] text-fg-muted">
                  <span>
                    Posted by <strong className="font-medium text-fg">{item.authorName}</strong>
                  </span>
                  {item.expiresAt && <span>Expires: {new Date(item.expiresAt).toLocaleDateString()}</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {canAuthor && (
        <AnnouncementComposerModal
          schoolCode={schoolCode}
          isOpen={composerOpen}
          onClose={() => setComposerOpen(false)}
          onSaved={() => reload()}
          initialAnnouncement={editingAnnouncement}
          campuses={campuses}
          classArms={classArms}
        />
      )}
    </section>
  );
}

import { Role, AnnouncementStatus } from "@prisma/client";

export { Role, AnnouncementStatus };

export interface AnnouncementLike {
  id?: string;
  status: AnnouncementStatus;
  targetRoles: Role[];
  campusId?: string | null;
  classArmId?: string | null;
  authorUserId: string;
  isPinned: boolean;
  publishedAt: Date;
  expiresAt?: Date | null;
}

export interface ViewerProfile {
  userId: string;
  role: Role;
  campusId?: string | null;
  classArmId?: string | null;
}

/**
 * Checks whether an announcement is currently within its active publication window.
 */
export function isAnnouncementActive(
  announcement: Pick<AnnouncementLike, "status" | "publishedAt" | "expiresAt">,
  now = new Date(),
): boolean {
  if (announcement.status !== AnnouncementStatus.PUBLISHED) {
    return false;
  }

  const pubTime = new Date(announcement.publishedAt).getTime();
  if (pubTime > now.getTime()) {
    return false;
  }

  if (announcement.expiresAt) {
    const expTime = new Date(announcement.expiresAt).getTime();
    if (expTime <= now.getTime()) {
      return false;
    }
  }

  return true;
}

/**
 * Checks whether an announcement's audience targets match the viewer's profile.
 * - Empty targetRoles means school-wide broadcast (matches all roles).
 * - Null campusId means all campuses.
 * - Null classArmId means all class arms.
 */
export function matchesAudience(
  announcement: Pick<AnnouncementLike, "targetRoles" | "campusId" | "classArmId">,
  viewer: ViewerProfile,
): boolean {
  // 1. Role match
  if (announcement.targetRoles && announcement.targetRoles.length > 0) {
    if (!announcement.targetRoles.includes(viewer.role)) {
      return false;
    }
  }

  // 2. Campus match
  if (announcement.campusId) {
    if (!viewer.campusId || announcement.campusId !== viewer.campusId) {
      return false;
    }
  }

  // 3. Class arm match
  if (announcement.classArmId) {
    if (!viewer.classArmId || announcement.classArmId !== viewer.classArmId) {
      return false;
    }
  }

  return true;
}

/**
 * Determines if an announcement should be visible in a viewer's feed.
 * Admins and authors can always see their own draft/archived announcements.
 * General recipients only see active, audience-matching announcements.
 */
export function isAnnouncementVisible(announcement: AnnouncementLike, viewer: ViewerProfile, now = new Date()): boolean {
  // Admins can see all announcements within the school
  if (viewer.role === Role.ADMIN) {
    return true;
  }

  // Authors can always see their own announcements (even drafts or expired)
  if (viewer.userId && announcement.authorUserId === viewer.userId) {
    return true;
  }

  // For others: must be active and match audience
  if (!isAnnouncementActive(announcement, now)) {
    return false;
  }

  return matchesAudience(announcement, viewer);
}

/**
 * Sorts announcements: pinned announcements first, then chronologically by publishedAt descending.
 */
export function sortAnnouncements<T extends Pick<AnnouncementLike, "isPinned" | "publishedAt">>(announcements: T[]): T[] {
  return [...announcements].sort((a, b) => {
    if (a.isPinned !== b.isPinned) {
      return a.isPinned ? -1 : 1;
    }
    const aTime = new Date(a.publishedAt).getTime();
    const bTime = new Date(b.publishedAt).getTime();
    return bTime - aTime;
  });
}

/**
 * Evaluates whether a user role has authority to author announcements.
 */
export function canAuthorAnnouncements(role: Role): boolean {
  return role === Role.ADMIN || role === Role.TEACHING_STAFF;
}

/**
 * Evaluates whether a user can edit/delete a given announcement.
 */
export function canManageAnnouncement(
  announcement: Pick<AnnouncementLike, "authorUserId">,
  viewer: { userId: string; role: Role },
): boolean {
  if (viewer.role === Role.ADMIN) return true;
  return viewer.userId === announcement.authorUserId;
}

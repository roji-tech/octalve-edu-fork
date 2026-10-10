import { test, expect } from "@playwright/test";
import {
  isAnnouncementActive,
  matchesAudience,
  isAnnouncementVisible,
  sortAnnouncements,
  canAuthorAnnouncements,
  canManageAnnouncement,
  Role,
  AnnouncementStatus,
  type AnnouncementLike,
  type ViewerProfile,
} from "@/lib/announcements/rules";

test.describe("Announcements Pure Rules", () => {
  const fixedNow = new Date("2026-10-15T10:00:00Z");

  test.describe("active window checks", () => {
    test("isAnnouncementActive enforces PUBLISHED status and date boundaries", () => {
      // Draft is never active
      expect(
        isAnnouncementActive(
          {
            status: AnnouncementStatus.DRAFT,
            publishedAt: new Date("2026-10-10T00:00:00Z"),
          },
          fixedNow,
        ),
      ).toBe(false);

      // Future publication date is not active yet
      expect(
        isAnnouncementActive(
          {
            status: AnnouncementStatus.PUBLISHED,
            publishedAt: new Date("2026-10-16T00:00:00Z"),
          },
          fixedNow,
        ),
      ).toBe(false);

      // Published without expiry is active
      expect(
        isAnnouncementActive(
          {
            status: AnnouncementStatus.PUBLISHED,
            publishedAt: new Date("2026-10-10T00:00:00Z"),
          },
          fixedNow,
        ),
      ).toBe(true);

      // Published with unexpired expiry is active
      expect(
        isAnnouncementActive(
          {
            status: AnnouncementStatus.PUBLISHED,
            publishedAt: new Date("2026-10-10T00:00:00Z"),
            expiresAt: new Date("2026-10-20T00:00:00Z"),
          },
          fixedNow,
        ),
      ).toBe(true);

      // Published but already expired is not active
      expect(
        isAnnouncementActive(
          {
            status: AnnouncementStatus.PUBLISHED,
            publishedAt: new Date("2026-10-10T00:00:00Z"),
            expiresAt: new Date("2026-10-14T00:00:00Z"),
          },
          fixedNow,
        ),
      ).toBe(false);
    });
  });

  test.describe("audience matching", () => {
    test("matchesAudience allows school-wide broadcast (empty roles) to any role", () => {
      const broadcast = {
        targetRoles: [],
        campusId: null,
        classArmId: null,
      };

      expect(matchesAudience(broadcast, { userId: "u1", role: Role.STUDENT })).toBe(true);
      expect(matchesAudience(broadcast, { userId: "u2", role: Role.PARENT })).toBe(true);
      expect(matchesAudience(broadcast, { userId: "u3", role: Role.TEACHING_STAFF })).toBe(true);
    });

    test("matchesAudience filters by targeted roles", () => {
      const staffOnly = {
        targetRoles: [Role.TEACHING_STAFF, Role.NON_TEACHING_STAFF],
        campusId: null,
        classArmId: null,
      };

      expect(matchesAudience(staffOnly, { userId: "u1", role: Role.TEACHING_STAFF })).toBe(true);
      expect(matchesAudience(staffOnly, { userId: "u2", role: Role.NON_TEACHING_STAFF })).toBe(true);
      expect(matchesAudience(staffOnly, { userId: "u3", role: Role.STUDENT })).toBe(false);
      expect(matchesAudience(staffOnly, { userId: "u4", role: Role.PARENT })).toBe(false);
    });

    test("matchesAudience filters by campus and class arm", () => {
      const campusSpecific = {
        targetRoles: [],
        campusId: "campus-main",
        classArmId: null,
      };

      expect(matchesAudience(campusSpecific, { userId: "u1", role: Role.STUDENT, campusId: "campus-main" })).toBe(true);
      expect(matchesAudience(campusSpecific, { userId: "u2", role: Role.STUDENT, campusId: "campus-annex" })).toBe(false);

      const armSpecific = {
        targetRoles: [Role.STUDENT, Role.PARENT],
        campusId: "campus-main",
        classArmId: "arm-ss1-a",
      };

      expect(
        matchesAudience(armSpecific, {
          userId: "u1",
          role: Role.STUDENT,
          campusId: "campus-main",
          classArmId: "arm-ss1-a",
        }),
      ).toBe(true);

      expect(
        matchesAudience(armSpecific, {
          userId: "u2",
          role: Role.STUDENT,
          campusId: "campus-main",
          classArmId: "arm-ss1-b",
        }),
      ).toBe(false);
    });
  });

  test.describe("visibility and sorting", () => {
    const sampleItem: AnnouncementLike = {
      id: "a-1",
      status: AnnouncementStatus.PUBLISHED,
      targetRoles: [Role.TEACHING_STAFF],
      campusId: null,
      classArmId: null,
      authorUserId: "author-1",
      isPinned: false,
      publishedAt: new Date("2026-10-10T00:00:00Z"),
      expiresAt: null,
    };

    test("admin can view all announcements regardless of audience or status", () => {
      const adminViewer: ViewerProfile = { userId: "admin-1", role: Role.ADMIN };
      expect(isAnnouncementVisible(sampleItem, adminViewer, fixedNow)).toBe(true);

      const draftItem: AnnouncementLike = { ...sampleItem, status: AnnouncementStatus.DRAFT };
      expect(isAnnouncementVisible(draftItem, adminViewer, fixedNow)).toBe(true);
    });

    test("author can view own announcements even when draft or expired", () => {
      const authorViewer: ViewerProfile = { userId: "author-1", role: Role.TEACHING_STAFF };
      const expiredItem: AnnouncementLike = {
        ...sampleItem,
        expiresAt: new Date("2026-10-12T00:00:00Z"),
      };
      expect(isAnnouncementVisible(expiredItem, authorViewer, fixedNow)).toBe(true);
    });

    test("sortAnnouncements places pinned items first, then descending by publishedAt", () => {
      const items = [
        { isPinned: false, publishedAt: new Date("2026-10-12T10:00:00Z"), title: "Older unpinned" },
        { isPinned: false, publishedAt: new Date("2026-10-14T10:00:00Z"), title: "Newer unpinned" },
        { isPinned: true, publishedAt: new Date("2026-10-11T10:00:00Z"), title: "Older pinned" },
        { isPinned: true, publishedAt: new Date("2026-10-13T10:00:00Z"), title: "Newer pinned" },
      ];

      const sorted = sortAnnouncements(items);
      expect(sorted[0].title).toBe("Newer pinned");
      expect(sorted[1].title).toBe("Older pinned");
      expect(sorted[2].title).toBe("Newer unpinned");
      expect(sorted[3].title).toBe("Older unpinned");
    });

    test("permissions evaluation", () => {
      expect(canAuthorAnnouncements(Role.ADMIN)).toBe(true);
      expect(canAuthorAnnouncements(Role.TEACHING_STAFF)).toBe(true);
      expect(canAuthorAnnouncements(Role.STUDENT)).toBe(false);
      expect(canAuthorAnnouncements(Role.PARENT)).toBe(false);

      expect(canManageAnnouncement(sampleItem, { userId: "admin-x", role: Role.ADMIN })).toBe(true);
      expect(canManageAnnouncement(sampleItem, { userId: "author-1", role: Role.TEACHING_STAFF })).toBe(true);
      expect(canManageAnnouncement(sampleItem, { userId: "other-user", role: Role.TEACHING_STAFF })).toBe(false);
    });
  });
});

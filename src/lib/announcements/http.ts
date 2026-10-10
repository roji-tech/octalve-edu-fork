import { z } from "zod";
import { Role, AnnouncementStatus } from "@prisma/client";
import { fail } from "@/lib/api/envelope";

export const createAnnouncementSchema = z.strictObject({
  title: z.string().min(1, "Title is required").max(200, "Title cannot exceed 200 characters"),
  body: z.string().min(1, "Content body is required"),
  targetRoles: z.array(z.nativeEnum(Role)).optional().default([]),
  campusId: z.string().nullable().optional(),
  classArmId: z.string().nullable().optional(),
  status: z.nativeEnum(AnnouncementStatus).optional().default(AnnouncementStatus.PUBLISHED),
  isPinned: z.boolean().optional().default(false),
  publishedAt: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/))
    .optional(),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/))
    .nullable()
    .optional(),
});

export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

export const updateAnnouncementSchema = z.strictObject({
  title: z.string().min(1, "Title cannot be empty").max(200, "Title cannot exceed 200 characters").optional(),
  body: z.string().min(1, "Content body cannot be empty").optional(),
  targetRoles: z.array(z.nativeEnum(Role)).optional(),
  campusId: z.string().nullable().optional(),
  classArmId: z.string().nullable().optional(),
  status: z.nativeEnum(AnnouncementStatus).optional(),
  isPinned: z.boolean().optional(),
  publishedAt: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/))
    .optional(),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}/))
    .nullable()
    .optional(),
});

export type UpdateAnnouncementInput = z.infer<typeof updateAnnouncementSchema>;

export const queryAnnouncementsSchema = z.strictObject({
  status: z.nativeEnum(AnnouncementStatus).optional(),
  campusId: z.string().optional(),
  classArmId: z.string().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type QueryAnnouncementsInput = z.infer<typeof queryAnnouncementsSchema>;

export type AnnouncementFailure = "NOT_FOUND" | "UNAUTHORIZED" | "INVALID_AUDIENCE" | "BAD_REQUEST";

export function announcementFailure(reason: AnnouncementFailure, detail?: string): Response {
  switch (reason) {
    case "NOT_FOUND":
      return fail(detail ?? "Announcement not found.", 404, "NOT_FOUND");
    case "UNAUTHORIZED":
      return fail(detail ?? "You do not have permission to perform this action.", 403, "FORBIDDEN");
    case "INVALID_AUDIENCE":
      return fail(detail ?? "Invalid audience configuration for this announcement.", 400, "INVALID_AUDIENCE");
    default:
      return fail(detail ?? "Announcement operation failed.", 400, "BAD_REQUEST");
  }
}

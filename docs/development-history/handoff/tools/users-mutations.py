# The 0.5.4 (Users pages and invitations) mutation set — 122 injected bugs, written by the reviewer session, NEVER YET RUN.
# Run with docs/development-history/handoff/tools/run-mutations.py (see TAKEOVER.md step 2). Every pattern was checked to match exactly
# once in the sources at the time of writing (a dry check is built into the runner).
# Format: id, description, edits [(file, old, new)], cmd (the targeted tests), build (rebuild before running), fresh_db (new test database).
# A mutation that SURVIVES means a missing or weak test — or an equivalent mutant (those marked EXPECTED EQUIVALENT: justify them in the record).
ISVC = "src/lib/invitations/service.ts"
IST = "src/lib/invitations/status.ts"
ITK = "src/lib/invitations/token.ts"
MSVC = "src/lib/members/service.ts"
MHTTP = "src/lib/members/http.ts"
MIG = "prisma/migrations/20261009090000_users_invitations/migration.sql"
R_MEM = "src/app/api/v1/schools/[code]/members/route.ts"
R_MEMID = "src/app/api/v1/schools/[code]/members/[userId]/route.ts"
R_DEACT = "src/app/api/v1/schools/[code]/members/[userId]/deactivate/route.ts"
R_REACT = "src/app/api/v1/schools/[code]/members/[userId]/reactivate/route.ts"
R_INV = "src/app/api/v1/schools/[code]/invitations/route.ts"
R_INVID = "src/app/api/v1/schools/[code]/invitations/[id]/route.ts"
R_RESEND = "src/app/api/v1/schools/[code]/invitations/[id]/resend/route.ts"
R_ACCEPT = "src/app/api/v1/invitations/accept/route.ts"
R_PREVIEW = "src/app/api/v1/invitations/preview/route.ts"
MSG = "src/lib/email/messages.ts"
UP = "src/components/users/UsersPanel.tsx"
INVD = "src/components/users/InviteDialog.tsx"
DEACT_D = "src/components/users/DeactivateDialog.tsx"
ACC_PAGE = "src/app/accept-invite/page.tsx"
ACC_FORM = "src/components/auth/AcceptInviteForm.tsx"
USERS_PAGE = "src/app/(app)/schools/[code]/users/page.tsx"

P = "pnpm exec playwright test"
INTI = f"{P} --project=integration tests/integration/invitations.spec.ts tests/integration/members.spec.ts tests/integration/deactivated-members.spec.ts tests/integration/rls.spec.ts --reporter=line"
APIS = f"{P} --project=api tests/api/invitations.spec.ts tests/api/members.spec.ts tests/api/deactivated-members.spec.ts tests/api/tenant-boundary.spec.ts tests/api/csrf.spec.ts --reporter=line"
DEACT = f"{P} --project=integration tests/integration/deactivated-members.spec.ts --project=api tests/api/deactivated-members.spec.ts --reporter=line"
E2E = f"{P} --project=e2e-desktop --project=e2e-mobile tests/e2e/users.spec.ts tests/e2e/accept-invite.spec.ts --reporter=line"


def m(id, desc, edits, cmd=INTI, build=False, fresh_db=False):
    return dict(id=id, desc=desc, edits=edits, cmd=cmd, build=build, fresh_db=fresh_db)


def sql(id, desc, edits):
    return m(id, desc, [(MIG, o, n) for o, n in edits], INTI, False, True)


def roles_open(id, desc, path, old, new):
    return m(id, desc, [(path, old, new)], APIS, True)


ADMIN_ONLY = '{ tenant: true, roles: ["ADMIN"] },'
OPEN = "{ tenant: true },"

MUTATIONS = [
  # --- invitations: the administrator's side -----------------------------------------------------------------------------------
  m("I1", "no advisory lock: two administrators inviting the same person at once collide on the index", [(ISVC, "    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invitation:${tenantId}:${input.email}`}::text))`;\n", "")]),
  m("I2", "a campus of ANOTHER school is accepted on an invitation (the check is dropped)", [(ISVC, 'if (!campus) return { ok: false, reason: "INVALID_CAMPUS" };', "void campus;")]),
  m("I2b", "campus lookup not scoped to the school (EXPECTED EQUIVALENT: Campus row-level security scopes it anyway)", [(ISVC, "where: { id: input.campusId, tenantId }", "where: { id: input.campusId }")]),
  m("I3a", "a deactivated member is reported as an ordinary member", [(ISVC, 'member.deactivatedAt ? "DEACTIVATED_MEMBER" : "ALREADY_MEMBER"', '"ALREADY_MEMBER"')]),
  m("I3b", "a deactivated member CAN be invited again (instead of 'reactivate them')", [(ISVC, 'if (member) return { ok: false, reason: member.deactivatedAt ? "DEACTIVATED_MEMBER" : "ALREADY_MEMBER" };', 'if (member && !member.deactivatedAt) return { ok: false, reason: "ALREADY_MEMBER" };')]),
  m("I3c", "the member check matches ANY member of the school, not the invited address", [(ISVC, "where: { tenantId, user: { email: input.email } }, select: { deactivatedAt: true }", "where: { tenantId }, select: { deactivatedAt: true }")]),
  m("I4a", "an earlier open invitation is not revoked when a new one is made", [(ISVC, "for (const old of earlier) {", "for (const old of [] as typeof earlier) {")]),
  m("I4b", "the replaced invitation is revoked but not audited", [(ISVC, '      await tx.auditLog.create({\n        data: { tenantId, actorUserId, action: "INVITATION_REVOKED", targetType: "Invitation", targetId: old.id, afterValue: { email: input.email }, reason: "replaced by a new invitation" },\n      });\n', "")]),
  m("I5a", "the TOKEN, not its hash, is stored", [(ISVC, "        tokenHash: hashInvitationToken(token),\n        invitedById", "        tokenHash: token,\n        invitedById")]),
  m("I5b", "who invited is not recorded", [(ISVC, "        invitedById: actorUserId,\n", "")]),
  m("I5c", "the new invitation lasts one day, not seven", [(ISVC, "        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),\n", "        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),\n")]),
  m("I5d", "creating an invitation is not audited", [(ISVC, '    await tx.auditLog.create({\n      data: { tenantId, actorUserId, action: "INVITATION_CREATED", targetType: "Invitation", targetId: created.id, afterValue: { email: input.email, role: input.role, campusId: input.campusId } },\n    });\n', "")]),
  m("I5e", "the TTL constant is 30 days", [(ITK, "INVITATION_TTL_DAYS = 7", "INVITATION_TTL_DAYS = 30")]),
  m("I6a", "resend does not replace the token (the earlier link keeps working; the new one does not exist)", [(ISVC, "data: { tokenHash: hashInvitationToken(token), expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) },", "data: { expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) },")]),
  m("I6b", "resend does not renew the expiry", [(ISVC, "data: { tokenHash: hashInvitationToken(token), expiresAt: new Date(now.getTime() + INVITATION_TTL_MS) },", "data: { tokenHash: hashInvitationToken(token) },")]),
  m("I6c", "an ACCEPTED invitation can be resent", [(ISVC, "where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, select: { id: true, email: true }", "where: { id: invitationId, tenantId, revokedAt: null }, select: { id: true, email: true }")]),
  m("I6d", "a REVOKED invitation can be resent", [(ISVC, "where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, select: { id: true, email: true }", "where: { id: invitationId, tenantId, acceptedAt: null }, select: { id: true, email: true }")]),
  m("I6e", "resend is not audited", [(ISVC, '    await tx.auditLog.create({ data: { tenantId, actorUserId, action: "INVITATION_RESENT", targetType: "Invitation", targetId: open.id, afterValue: { email: open.email } } });\n', "")]),
  m("I7a", "an ACCEPTED invitation can be 'revoked' (and the answer is success)", [(ISVC, "where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() }", "where: { id: invitationId, tenantId, revokedAt: null }, data: { revokedAt: new Date() }")]),
  m("I7b", "revoking an already-revoked invitation succeeds again (and is audited twice)", [(ISVC, "where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() }", "where: { id: invitationId, tenantId, acceptedAt: null }, data: { revokedAt: new Date() }")]),
  m("I7c", "revoke is not audited", [(ISVC, '    await tx.auditLog.create({ data: { tenantId, actorUserId, action: "INVITATION_REVOKED", targetType: "Invitation", targetId: invitationId, afterValue: { email: target?.email ?? null } } });\n', "")]),
  m("I8a", "the open-invitations list includes revoked ones", [(ISVC, "const where: Prisma.InvitationWhereInput = { tenantId, acceptedAt: null, revokedAt: null };", "const where: Prisma.InvitationWhereInput = { tenantId, acceptedAt: null };")]),
  m("I8b", "the open-invitations list includes accepted ones", [(ISVC, "const where: Prisma.InvitationWhereInput = { tenantId, acceptedAt: null, revokedAt: null };", "const where: Prisma.InvitationWhereInput = { tenantId, revokedAt: null };")]),
  m("I8c", "the list is oldest first", [(ISVC, 'orderBy: [{ createdAt: "desc" }, { id: "asc" }]', 'orderBy: [{ createdAt: "asc" }, { id: "asc" }]')]),
  m("I8d", "the list is not scoped to the school (EXPECTED EQUIVALENT: Invitation row-level security scopes it anyway)", [(ISVC, "const where: Prisma.InvitationWhereInput = { tenantId, acceptedAt: null, revokedAt: null };", "const where: Prisma.InvitationWhereInput = { acceptedAt: null, revokedAt: null };")]),
  m("I8e", "the token HASH is selected and returned in every invitation the API shows", [(ISVC, "const PUBLIC_SELECT = {\n  id: true,", "const PUBLIC_SELECT = {\n  tokenHash: true,\n  id: true,"), (ISVC, "const toPublic = (row: InvitationRow, now: Date = new Date()): PublicInvitation => ({\n  id: row.id,", "const toPublic = (row: InvitationRow, now: Date = new Date()): PublicInvitation => ({\n  ...row,\n  id: row.id,")]),

  # --- invitations: the invitee's side -----------------------------------------------------------------------------------------
  m("V1", "preview shows a used / revoked / expired invitation", [(ISVC, "if (!found || !isLiveInvitation(found)) return null;", "if (!found) return null;")]),
  m("V2", "preview shows the FULL address", [(ISVC, "maskedEmail: maskEmail(found.email)", "maskedEmail: found.email")]),
  m("V3", "preview says every signed-in viewer is the invitee", [(ISVC, 'account?.id === viewerUserId ? "invitee" : "other"', '"invitee"')]),
  m("V4", "status: an invitation is 'pending' at the instant it expires (>= instead of >)", [(IST, "times.expiresAt.getTime() > now.getTime()", "times.expiresAt.getTime() >= now.getTime()")]),
  m("V5", "status: revoked outranks accepted", [(IST, '  if (times.acceptedAt) return "accepted";\n  if (times.revokedAt) return "revoked";', '  if (times.revokedAt) return "revoked";\n  if (times.acceptedAt) return "accepted";')]),
  m("V6", "status: an expired invitation is still 'pending'", [(IST, 'return times.expiresAt.getTime() > now.getTime() ? "pending" : "expired";', 'return "pending";')]),
  m("T1", "the token is 16 bytes (128 bits), not 32", [(ITK, "crypto.randomBytes(32)", "crypto.randomBytes(16)")]),
  m("T2", "the token shape check accepts any string", [(ITK, "/^[A-Za-z0-9_-]{43}$/.test(value)", "true")]),
  m("T3", "the stored form changes (sha1 instead of sha256)", [(ITK, 'crypto.createHash("sha256")', 'crypto.createHash("sha1")')]),

  # --- accept ------------------------------------------------------------------------------------------------------------------
  m("A1", "accept does not check the invitation is live (the claim alone decides)", [(ISVC, "if (!found || !isLiveInvitation(found, now)) throw new Abort(\"INVALID\");", "if (!found) throw new Abort(\"INVALID\");")]),
  m("A2", "someone signed in as ANOTHER account attaches the invitee's account", [(ISVC, 'if (!account || account.id !== input.viewerUserId) throw new Abort("WRONG_ACCOUNT");', 'if (!account) throw new Abort("WRONG_ACCOUNT");')]),
  m("A3", "a signed-out token holder attaches an EXISTING account (no sign-in needed)", [(ISVC, "} else if (account) {\n        throw new Abort(\"SIGN_IN_REQUIRED\");", "} else if (false) {\n        throw new Abort(\"SIGN_IN_REQUIRED\");")]),
  m("A4", "an ACTIVE member can accept again (and have their role rewritten)", [(ISVC, '      if (existing && !existing.deactivatedAt) throw new Abort("ALREADY_MEMBER");\n', "")]),
  m("A5", "a deactivated member cannot come back through an invitation", [(ISVC, "if (existing && !existing.deactivatedAt) throw new Abort(\"ALREADY_MEMBER\");", "if (existing) throw new Abort(\"ALREADY_MEMBER\");")]),
  m("A6", "the claim ignores 'already accepted' (single use rests on the pre-read only)", [(ISVC, "where: { id: found.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },", "where: { id: found.id, revokedAt: null, expiresAt: { gt: now } },")]),
  m("A7", "the claim ignores 'revoked'", [(ISVC, "where: { id: found.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },", "where: { id: found.id, acceptedAt: null, expiresAt: { gt: now } },")]),
  m("A8", "the claim does not count the rows it changed", [(ISVC, "if (claimed.count !== 1) throw new Abort(\"INVALID\");", "void claimed;")]),
  m("A9", "a new account's address is not marked verified", [(ISVC, "passwordHash: input.newAccount!.passwordHash, emailVerified: now }", "passwordHash: input.newAccount!.passwordHash }")]),
  m("A10", "an account created in the meantime (unique violation) is a 500, not 'sign in'", [(ISVC, '(error as { code?: string }).code === "P2002") throw new Abort("SIGN_IN_REQUIRED");', '(error as { code?: string }).code === "P2002") throw error;')]),
  m("A11", "reactivation leaves the person deactivated", [(ISVC, "data: { role: found.role, campusId: found.campusId, deactivatedAt: null }", "data: { role: found.role, campusId: found.campusId }")]),
  m("A12", "reactivation keeps the OLD role and campus", [(ISVC, "data: { role: found.role, campusId: found.campusId, deactivatedAt: null }", "data: { deactivatedAt: null }")]),
  m("A13", "the new membership ignores the invited campus", [(ISVC, "data: { userId, tenantId: found.tenantId, role: found.role, campusId: found.campusId }", "data: { userId, tenantId: found.tenantId, role: found.role }")]),
  m("A14", "the new membership ignores the invited role (always a parent)", [(ISVC, "data: { userId, tenantId: found.tenantId, role: found.role, campusId: found.campusId }", 'data: { userId, tenantId: found.tenantId, role: "PARENT", campusId: found.campusId }')]),
  m("A15", "who accepted is not recorded", [(ISVC, "      await tx.invitation.update({ where: { id: found.id }, data: { acceptedById: userId } });\n", "")]),
  m("A16", "acceptance is audited under the wrong action name", [(ISVC, '      await tx.auditLog.create({\n        data: {\n          tenantId: found.tenantId,\n          actorUserId: userId,\n          action: "INVITATION_ACCEPTED",', '      await tx.auditLog.create({\n        data: {\n          tenantId: found.tenantId,\n          actorUserId: userId,\n          action: "INVITATION_ACCEPTED_NEVER",')]),
  m("A17", "the tenant context is never set from the invitation row (every write is refused by row-level security)", [(ISVC, "      await setTenantContext(tx, trustedTenantId(found.tenantId));\n", "")]),

  # --- members -----------------------------------------------------------------------------------------------------------------
  m("M1a", "an administrator can change THEMSELVES", [(MSVC, '  change: { role?: Role; campusId?: string | null },\n): Promise<MemberResult> {\n  if (targetUserId === actorUserId) return { ok: false, reason: "SELF" };\n', '  change: { role?: Role; campusId?: string | null },\n): Promise<MemberResult> {\n')]),
  m("M1b", "an administrator can deactivate THEMSELVES", [(MSVC, 'export async function deactivateMember(tenant: TenantCtx, actorUserId: string, targetUserId: string): Promise<MemberResult> {\n  if (targetUserId === actorUserId) return { ok: false, reason: "SELF" };\n', 'export async function deactivateMember(tenant: TenantCtx, actorUserId: string, targetUserId: string): Promise<MemberResult> {\n')]),
  m("M1c", "an administrator can 'reactivate' themselves (differs only by answer: SELF vs a quiet no-op — a test should still pin it)", [(MSVC, 'export async function reactivateMember(tenant: TenantCtx, actorUserId: string, targetUserId: string): Promise<MemberResult> {\n  if (targetUserId === actorUserId) return { ok: false, reason: "SELF" };\n', 'export async function reactivateMember(tenant: TenantCtx, actorUserId: string, targetUserId: string): Promise<MemberResult> {\n')]),
  m("M2", "a deactivated member can still be changed", [(MSVC, '    if (current.deactivatedAt) return { ok: false, reason: "DEACTIVATED" };\n', "")]),
  m("M3", "a member's campus can be set to another school's campus", [(MSVC, 'if (!campus) return { ok: false, reason: "INVALID_CAMPUS" };', "void campus;")]),
  m("M3b", "campus lookup not scoped to the school (EXPECTED EQUIVALENT: Campus row-level security scopes it anyway)", [(MSVC, "where: { id: change.campusId, tenantId }", "where: { id: change.campusId }")]),
  m("M4", "a no-op change is written and audited as a change", [(MSVC, "    if (!roleChanged && !campusChanged) return { ok: true, member: toPublic(current), changed: false }; // a no-op writes nothing\n", "")]),
  m("M5", "the role counts as changed whenever one is given (an audit entry for nothing)", [(MSVC, "const roleChanged = change.role !== undefined && change.role !== current.role;", "const roleChanged = change.role !== undefined;")]),
  m("M6", "the campus counts as changed whenever one is given", [(MSVC, "const campusChanged = change.campusId !== undefined && change.campusId !== current.campusId;", "const campusChanged = change.campusId !== undefined;")]),
  m("M7", "the last-administrator rule also blocks changing a non-administrator's role", [(MSVC, 'if (roleChanged && current.role === "ADMIN" && change.role !== "ADMIN" && !(await hasAnotherActiveAdmin(tx, tenantId))) {', 'if (roleChanged && change.role !== "ADMIN" && !(await hasAnotherActiveAdmin(tx, tenantId))) {')]),
  m("M8", "demoting an administrator never checks for another one", [(MSVC, 'if (roleChanged && current.role === "ADMIN" && change.role !== "ADMIN" && !(await hasAnotherActiveAdmin(tx, tenantId))) {', "if (false) {")]),
  m("M9", "deactivating an administrator never checks for another one", [(MSVC, 'if (current.role === "ADMIN" && !(await hasAnotherActiveAdmin(tx, tenantId))) return { ok: false, reason: "LAST_ADMIN" };', "")]),
  m("M10", "the administrator count has no row lock (two administrators demote each other at the same instant)", [(MSVC, ' AND role = \'ADMIN\' AND "deactivatedAt" IS NULL FOR UPDATE`;', ' AND role = \'ADMIN\' AND "deactivatedAt" IS NULL`;')]),
  m("M11", "a deactivated administrator counts as 'another administrator'", [(MSVC, ' AND role = \'ADMIN\' AND "deactivatedAt" IS NULL FOR UPDATE`;', " AND role = 'ADMIN' FOR UPDATE`;")]),
  m("M12", "the threshold is 'at least one' (the last administrator is never the last)", [(MSVC, "return admins.length > 1;", "return admins.length >= 1;")]),
  m("M13", "search text is a pattern ('%' lists everyone)", [(MSVC, 'const escapeLike = (value: string) => value.replace(/[\\\\%_]/g, "\\\\$&");', "const escapeLike = (value: string) => value;")]),
  m("M14", "the default status filter shows deactivated people too", [(MSVC, 'filters.status === "active" ? { deactivatedAt: null } : ', 'filters.status === "active" ? {} : ')]),
  m("M15", "the member list leaks the whole row (ids, timestamps)", [(MSVC, "const toPublic = (row: MemberRow): PublicMember => ({\n  userId: row.userId,", "const toPublic = (row: MemberRow): PublicMember => ({\n  ...row,\n  userId: row.userId,")]),
  m("M16", "pages are ordered without a tiebreak (rows with the same name may repeat or vanish across pages)", [(MSVC, 'orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }, { id: "asc" }]', 'orderBy: [{ user: { name: "asc" } }]')]),
  m("M17", "the member list is not scoped to the school (EXPECTED EQUIVALENT: TenantMembership row-level security scopes it anyway)", [(MSVC, "    tenantId: tenant.tenantId,\n    ...(filters.role", "    ...(filters.role")]),
  m("M18", "reactivation is audited under the wrong action name", [(MSVC, '    await tx.auditLog.create({\n      data: { tenantId, actorUserId, action: "MEMBER_REACTIVATED"', '    await tx.auditLog.create({\n      data: { tenantId, actorUserId, action: "MEMBER_REACTIVATED_NEVER"')]),
  m("M19", "deactivation does not record the person's role and campus", [(MSVC, 'targetId: targetUserId, beforeValue: { role: current.role, campusId: current.campusId } },\n    });\n    return { ok: true, member: toPublic(updated), changed: true };\n  });\n}\n\nexport async function reactivateMember', 'targetId: targetUserId },\n    });\n    return { ok: true, member: toPublic(updated), changed: true };\n  });\n}\n\nexport async function reactivateMember')]),

  # --- readers: a deactivated membership is no membership ---------------------------------------------------------------------
  m("D1", "the tenant resolver still honours a deactivated membership", [("src/lib/tenant/resolve-tenant.ts", "where: { userId: input.userId, tenant: tenantFilter, deactivatedAt: null },", "where: { userId: input.userId, tenant: tenantFilter },")], DEACT, True),
  m("D2", "the person's school list still shows a deactivated membership", [("src/lib/auth/memberships.ts", "where: { userId, deactivatedAt: null }, // a deactivated membership is no membership", "where: { userId }, // a deactivated membership is no membership")], DEACT, True),
  m("D3", "the sign-in audit still counts a deactivated membership's school", [("src/lib/auth/audit.ts", "where: { userId, deactivatedAt: null }, select: { tenantId: true } }), // not a school they were removed from", "where: { userId }, select: { tenantId: true } }), // not a school they were removed from")], DEACT, True),
  m("D4", "a deactivated administrator still makes the instance 'has an administrator'", [("src/lib/auth/complete-sign-in.ts", "where: { userId: user.id, role: Role.ADMIN, deactivatedAt: null }", "where: { userId: user.id, role: Role.ADMIN }")], DEACT, True),

  # --- routes ------------------------------------------------------------------------------------------------------------------
  roles_open("H1", "GET members: any signed-in member of the school can list people", R_MEM, ADMIN_ONLY, OPEN),
  roles_open("H2", "PATCH member: any member can change people", R_MEMID, ADMIN_ONLY, OPEN),
  roles_open("H3", "deactivate: any member can deactivate people", R_DEACT, ADMIN_ONLY, OPEN),
  roles_open("H4", "reactivate: any member can reactivate people", R_REACT, ADMIN_ONLY, OPEN),
  roles_open("H5", "GET invitations: any member can list invitations", R_INV, 'total }));\n  },\n  { tenant: true, roles: ["ADMIN"] },', "total }));\n  },\n  { tenant: true },"),
  roles_open("H6", "POST invitations: any member can invite", R_INV, 'return ok({ invitation: result.invitation }, {}, 201);\n  }),\n  { tenant: true, roles: ["ADMIN"] },', "return ok({ invitation: result.invitation }, {}, 201);\n  }),\n  { tenant: true },"),
  roles_open("H7", "revoke: any member can revoke invitations", R_INVID, ADMIN_ONLY, OPEN),
  roles_open("H8", "resend: any member can resend invitations", R_RESEND, ADMIN_ONLY, OPEN),
  m("H9", "PATCH member accepts keys it does not name (tenantId, passwordHash…) and ignores them", [(R_MEMID, ".strictObject({ role: roleField.optional()", ".object({ role: roleField.optional()")], APIS, True),
  m("H10", "POST invitation accepts keys it does not name", [(R_INV, "z.strictObject({ email: emailField", "z.object({ email: emailField")], APIS, True),
  m("H11", "invited addresses keep their case (two spellings → two invitations)", [(MHTTP, '  .email("Enter a valid email address.")\n  .toLowerCase();', '  .email("Enter a valid email address.");')], APIS, True),
  m("H12", "invited addresses are not trimmed", [(MHTTP, "  .trim()\n  .max(254", "  .max(254")], APIS, True),
  m("H13", "preview: no CSRF check", [(R_PREVIEW, '  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");\n', "")], APIS, True),
  m("H14", "accept: no CSRF check", [(R_ACCEPT, '  if (!validateCSRF(req)) return fail("Cross-origin request blocked", 403, "CSRF");\n', "")], APIS, True),
  m("H15", "accept: a successful acceptance is not refunded from the per-IP limit", [(R_ACCEPT, "  await refundAttempt(ipKey);\n  return ok({ accepted: true", "  return ok({ accepted: true")], APIS, True),
  m("H16", "accept: the breached-password check is skipped for new accounts", [(R_ACCEPT, 'const problem = password ? await checkNewPasswordOnServer(password) : "Choose a password.";', 'const problem = password ? null : "Choose a password.";')], APIS, True),
  m("H17", "accept: the per-IP limit is effectively off", [(R_ACCEPT, "const IP_LIMIT = 10;", "const IP_LIMIT = 100000;")], APIS, True),
  m("H18", "preview: the per-IP limit is effectively off", [(R_PREVIEW, "const IP_LIMIT = 40;", "const IP_LIMIT = 100000;")], APIS, True),
  m("H19", "invite: the per-address limit is effectively off", [(R_INV, "const PER_ADDRESS = 3;", "const PER_ADDRESS = 100000;")], APIS, True),
  m("H20", "resend: the per-invitation limit is effectively off", [(R_RESEND, "const PER_INVITATION = 3;", "const PER_INVITATION = 100000;")], APIS, True),
  m("H21", "the mailed link carries the token in the QUERY (it would reach server logs)", [(MSG, "accept-invite#token=${token}", "accept-invite?token=${token}")], APIS, True),
  m("H22", "accept: a name that fails the profile rules is accepted", [(R_ACCEPT, "if (details.length > 0 || !checkedName.ok) {", "if (details.length > 0) {")], APIS, True),

  # --- SQL (fresh database per mutation) -------------------------------------------------------------------------------------
  sql("Q1", "Invitation: ENABLE row level security dropped", [('ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;\n', "")]),
  sql("Q2", "Invitation: FORCE dropped", [('ALTER TABLE "Invitation" FORCE ROW LEVEL SECURITY;\n', "")]),
  sql("Q3", "Invitation: the invitee's hash path to READ is removed (preview/accept could not find the row)", [('USING ("tenantId" = app_tenant_id() OR "tokenHash" = app_invitation_hash());', 'USING ("tenantId" = app_tenant_id());')]),
  sql("Q4", "Invitation: any tenant's invitations readable", [('USING ("tenantId" = app_tenant_id() OR "tokenHash" = app_invitation_hash());', "USING (true);")]),
  sql("Q5", "Invitation: rows can be inserted for another tenant", [('CREATE POLICY invitation_insert ON "Invitation" FOR INSERT\n  WITH CHECK ("tenantId" = app_tenant_id());', 'CREATE POLICY invitation_insert ON "Invitation" FOR INSERT\n  WITH CHECK (true);')]),
  sql("Q6", "Invitation: a row can be updated to belong to another tenant (WITH CHECK dropped)", [('CREATE POLICY invitation_update ON "Invitation" FOR UPDATE\n  USING ("tenantId" = app_tenant_id())\n  WITH CHECK ("tenantId" = app_tenant_id());', 'CREATE POLICY invitation_update ON "Invitation" FOR UPDATE\n  USING ("tenantId" = app_tenant_id())\n  WITH CHECK (true);')]),
  sql("Q7", "Invitation: any tenant's invitations can be updated", [('CREATE POLICY invitation_update ON "Invitation" FOR UPDATE\n  USING ("tenantId" = app_tenant_id())\n  WITH CHECK ("tenantId" = app_tenant_id());', 'CREATE POLICY invitation_update ON "Invitation" FOR UPDATE\n  USING (true)\n  WITH CHECK (true);')]),
  sql("Q8", "Invitation: any tenant's invitations can be deleted", [('CREATE POLICY invitation_delete ON "Invitation" FOR DELETE\n  USING ("tenantId" = app_tenant_id());', 'CREATE POLICY invitation_delete ON "Invitation" FOR DELETE\n  USING (true);')]),
  sql("Q9", "the one-live-invitation index is gone", [('CREATE UNIQUE INDEX "Invitation_one_live_per_address" ON "Invitation"("tenantId", "email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;', "")]),
  sql("Q10", "the one-live-invitation index is not partial (a revoked or accepted row would block a new invitation)", [('"Invitation"("tenantId", "email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;', '"Invitation"("tenantId", "email");')]),
  sql("Q11", "the token hash is not unique", [('CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");', 'CREATE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");')]),
  sql("Q12", "an empty hash setting matches rows (NULLIF dropped; only matters if a row with an EMPTY hash exists — a test should insert one)", [("SELECT NULLIF(current_setting('app.invitation_hash', true), '')", "SELECT current_setting('app.invitation_hash', true)")]),
  sql("Q13", "the tenant foreign key is dropped (EXPECTED to be caught only if a test checks referential integrity / cascade on school removal)", [('ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;', "")]),

  # --- user interface ----------------------------------------------------------------------------------------------------------
  m("U1", "your own row offers Edit/Deactivate", [(UP, "{self ? null : member.status === \"active\" ? (", "{member.status === \"active\" ? (")], E2E, True),
  m("U2", "your own row has no 'You' marker", [(UP, "{self && <span", "{false && <span")], E2E, True),
  m("U3", "the invite form sends no campus", [(INVD, "{ email: address, role, campusId: campusId || null }", "{ email: address, role, campusId: null }")], E2E, True),
  m("U4", "the invite form always sends the default role", [(INVD, "{ email: address, role, campusId: campusId || null }", '{ email: address, role: "TEACHING_STAFF", campusId: campusId || null }')], E2E, True),
  m("U5", "the deactivate dialog no longer opens on Cancel (the safe choice)", [(DEACT_D, "onClick={onClose} disabled={pending} data-initial-focus>", "onClick={onClose} disabled={pending}>")], E2E, True),
  m("U6", "'Next page' is never disabled", [(UP, "disabled={!meta.hasNext}", "disabled={false}")], E2E, True),
  m("U7", "the Users page does not refuse non-administrators", [(USERS_PAGE, '  if (tenant.role !== "ADMIN") forbidden();\n', "")], E2E, True),
  m("U8", "the accept page lets the Referer carry the link", [(ACC_PAGE, 'referrer: "no-referrer"', 'referrer: "origin"')], E2E, True),
  m("U9", "the accept form does not compare the two passwords", [(ACC_FORM, 'const mismatch = !problem && password !== confirm ? "The two passwords don\'t match." : null;', "const mismatch = null;")], E2E, True),
]

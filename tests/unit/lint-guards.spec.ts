import "../support/env";
import { test, expect } from "@playwright/test";
import { ESLint } from "eslint";

// The ESLint guards that keep tenant code on the tenant context (domain-implementation-plan.md §0.5.2). A lint rule
// nobody has seen fire is not a guard, so this lints small virtual files at the real paths and expects the errors.

const eslint = new ESLint();
async function lint(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

test.describe("restricted imports in school code", () => {
  const paths = ["src/app/api/v1/schools/[code]/members/route.ts", "src/app/(app)/schools/[code]/students/page.tsx"];
  for (const file of paths) {
    test(`${file}: the raw client is refused`, async () => {
      const messages = await lint(file, `import { prisma } from "@/lib/db";\nexport const x = prisma;\n`);
      expect(messages.join(" ")).toMatch(/tenant context/);
    });
    test(`${file}: minting a VerifiedTenantId is refused`, async () => {
      const messages = await lint(file, `import { trustedTenantId } from "@/lib/tenant/verified-tenant";\nexport const x = trustedTenantId("t");\n`);
      expect(messages.join(" ")).toMatch(/VerifiedTenantId/);
    });
    test(`${file}: the sanctioned imports are fine`, async () => {
      const messages = await lint(file, `import { forTenant } from "@/lib/tenant/for-tenant";\nexport const x = forTenant;\n`);
      expect(messages).toEqual([]);
    });
  }

  test("school code may not query `user` directly: no tenant column, so row-level security cannot protect it", async () => {
    const lintSyntax = async (filePath: string, code: string) => {
      const [result] = await eslint.lintText(code, { filePath });
      return result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message);
    };
    for (const file of paths) {
      expect((await lintSyntax(file, `export async function f(tx: any) { return tx.user.findMany(); }\n`)).join(" "), file).toMatch(/through `tenantMembership`/);
      expect((await lintSyntax(file, `export async function f(tx: any) { return tx.tenantMembership.findMany({ include: { user: true } }); }\n`)), file).toEqual([]);
    }
    // identity code (the invitation service reads a user by address) is not school code
    expect(await lintSyntax("src/lib/invitations/service.ts", `export async function f(tx: any) { return tx.user.findUnique({ where: { email: "x" } }); }\n`)).toEqual([]);
  });

  test("elsewhere the raw client is still allowed (identity code needs it)", async () => {
    expect(await lint("src/lib/auth/session-devices.ts", `import { prisma } from "@/lib/db";\nexport const x = prisma;\n`)).toEqual([]);
  });
});

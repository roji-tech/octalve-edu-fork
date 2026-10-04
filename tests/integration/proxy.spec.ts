import "../support/env";
import { test, expect } from "@playwright/test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

// proxy.ts called in-process: what it puts on the RESPONSE (what the browser enforces) and on the
// REQUEST (what Next reads the nonce from while rendering — without it Next's own scripts carry no
// nonce and the policy blocks the app).

const call = () => proxy(new NextRequest("http://localhost/login"));
const nonceOf = (policy: string) => policy.match(/'nonce-([^']+)'/)![1];

test.describe.configure({ mode: "serial" });

test("the response carries the policy, with a fresh nonce on every call", () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const policy = call().headers.get("content-security-policy")!;
    expect(policy).toContain("script-src 'self'");
    nonces.add(nonceOf(policy));
  }
  expect(nonces.size).toBe(50);
});

test("the SAME policy (same nonce) is forwarded on the request headers, where Next reads it", () => {
  const res = call();
  const forwarded = res.headers.get("x-middleware-request-content-security-policy");
  expect(forwarded).toBe(res.headers.get("content-security-policy"));
  expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
});

test("CSP_REPORT_ONLY=true switches the header NAME (response and request) and nothing else", () => {
  const before = process.env.CSP_REPORT_ONLY;
  process.env.CSP_REPORT_ONLY = "true";
  try {
    const res = call();
    expect(res.headers.get("content-security-policy")).toBeNull();
    const policy = res.headers.get("content-security-policy-report-only")!;
    expect(policy).toContain("script-src 'self'");
    expect(res.headers.get("x-middleware-request-content-security-policy-report-only")).toBe(policy);
  } finally {
    if (before === undefined) delete process.env.CSP_REPORT_ONLY;
    else process.env.CSP_REPORT_ONLY = before;
  }
});

test("only the exact value 'true' relaxes it: anything else stays enforcing", () => {
  const before = process.env.CSP_REPORT_ONLY;
  try {
    for (const value of ["1", "TRUE", "yes", "false", ""]) {
      process.env.CSP_REPORT_ONLY = value;
      expect(call().headers.get("content-security-policy"), value).toContain("script-src");
    }
  } finally {
    if (before === undefined) delete process.env.CSP_REPORT_ONLY;
    else process.env.CSP_REPORT_ONLY = before;
  }
});

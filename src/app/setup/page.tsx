import type { Metadata } from "next";
import { redirect, notFound } from "next/navigation";
import { isSetupComplete, isSoloMode } from "@/lib/setup/status";
import { SetupWizardForm } from "./SetupWizardForm";

export const metadata: Metadata = { title: "Set up your school" };
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  // SaaS mode has no single instance to bootstrap this way (PRD §4).
  if (!isSoloMode()) {
    notFound();
  }

  // Already done: this wizard is permanently disabled. Unknown (DB blip)
  // falls through and shows the form — never lock a deployer out of their own
  // bootstrap step because of a transient connection error.
  if ((await isSetupComplete()) === true) {
    redirect("/login");
  }

  const requiresToken = Boolean(process.env.SETUP_TOKEN);

  // Design §0.5.1: warn if a *production* build is configured for plain HTTP.
  // The session cookie's `Secure` flag follows the APP_URL scheme, so sign-in
  // still works on a trusted LAN — but nothing protects the session in transit.
  const insecureBaseUrl = process.env.NODE_ENV === "production" && !(process.env.APP_URL ?? "").startsWith("https://");

  return <SetupWizardForm requiresToken={requiresToken} insecureBaseUrl={insecureBaseUrl} />;
}

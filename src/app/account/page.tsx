import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { AppHeader } from "@/components/auth/AppHeader";
import { ChangeEmailPanel } from "@/components/auth/ChangeEmailPanel";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { ProfileDetails } from "@/components/auth/ProfileDetails";
import { SessionsPanel } from "@/components/auth/SessionsPanel";
import { SessionRevalidator } from "@/components/auth/SessionRevalidator";
import { TwoStepPanel } from "@/components/auth/TwoStepPanel";
import { Card } from "@/components/ui/Card";
import { mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { getMfaStatus } from "@/lib/auth/mfa/service";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

// Octalve Edu's account page, inside the plain header until its app shell arrives with §0.5.2 (AlEemaan's
// already lives in the shell). Same cards, same forms.
export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const { name, email } = session.user;
  const mfa = await getMfaStatus(session.userId);

  return (
    <div className="min-h-screen bg-canvas text-fg-2">
      <SessionRevalidator />
      <AppHeader name={name} email={email} />
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6 sm:py-14">
        <h1 className="text-3xl font-bold tracking-tight text-fg">Account</h1>

        <Card>
          <h2 className="text-lg font-semibold text-fg">Profile</h2>
          <ProfileDetails name={name} email={email} />
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-fg">Email address</h2>
          <p className="mt-1 text-sm text-fg-muted">
            It&apos;s what you sign in with, and where password reset links go.
          </p>
          <ChangeEmailPanel email={email} />
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-fg">Password</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Changing it signs you out of every other device.
          </p>
          <ChangePasswordForm />
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-fg">Two-step verification</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Protect your account with a code from an authenticator app, as well as your password.
          </p>
          <TwoStepPanel
            available={mfaConfigured()}
            enabled={mfa.enabled}
            recoveryCodesRemaining={mfa.recoveryCodesRemaining}
          />
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-fg">Active sessions</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Where you&apos;re signed in. If you don&apos;t recognise one, sign it out and change your password.
          </p>
          <SessionsPanel />
        </Card>
      </main>
    </div>
  );
}

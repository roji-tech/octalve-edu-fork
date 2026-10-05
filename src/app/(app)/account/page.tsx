import type { Metadata } from "next";
import { ChangeEmailPanel } from "@/components/auth/ChangeEmailPanel";
import { ChangePasswordForm } from "@/components/auth/ChangePasswordForm";
import { ProfileDetails } from "@/components/auth/ProfileDetails";
import { SessionsPanel } from "@/components/auth/SessionsPanel";
import { TwoStepPanel } from "@/components/auth/TwoStepPanel";
import { PageHeader } from "@/components/shell/PageHeader";
import { Card } from "@/components/ui/Card";
import { requirePageSession } from "@/lib/auth/page-session";
import { mfaConfigured } from "@/lib/auth/mfa/secret-box";
import { getMfaStatus } from "@/lib/auth/mfa/service";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

// The account page, inside the app shell. Not school-specific: it is about the PERSON (profile, sign-in address,
// password, two-step, devices), whichever school they came from.
export default async function AccountPage() {
  const { session } = await requirePageSession();
  const { name, email } = session.user;
  const mfa = await getMfaStatus(session.userId);

  return (
    <div className="space-y-8">
      <PageHeader title="Account" description="Your profile, how you sign in, and where you are signed in." />

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
    </div>
  );
}

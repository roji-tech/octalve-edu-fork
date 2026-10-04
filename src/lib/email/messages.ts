import { brand } from "@/lib/brand";

// Plain-text messages: accessible everywhere, nothing to track or render wrongly.

import { RESET_LINK_MINUTES } from "@/lib/auth/reset-constants";

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

/// The token travels in the URL FRAGMENT: browsers never send it to the server, so it is not in access
/// logs and not in a Referer. The reset page reads it and removes it from the address bar.
export function resetLink(token: string): string {
  return `${appUrl()}/reset-password#token=${token}`;
}

export function resetEmail(to: string, token: string) {
  return {
    to,
    subject: `Reset your ${brand.name} password`,
    text: [
      `Someone asked to reset the password for your ${brand.name} account.`,
      ``,
      `To choose a new password, open this link within ${RESET_LINK_MINUTES} minutes:`,
      resetLink(token),
      ``,
      `If you didn't ask for this, ignore this message — your password hasn't changed and the link stops working by itself.`,
    ].join("\n"),
  };
}

const SECURITY_ADVICE = `If this wasn't you, change your password straight away and tell your school administrator.`;

export function mfaEnabledEmail(to: string) {
  return {
    to,
    subject: `Two-step verification is on for your ${brand.name} account`,
    text: [
      `Two-step verification was just turned on for your ${brand.name} account, and you were signed out of your other devices.`,
      ``,
      `From now on, signing in needs a code from your authenticator app as well as your password. Keep your recovery codes somewhere safe.`,
      ``,
      SECURITY_ADVICE,
    ].join("\n"),
  };
}

export function mfaDisabledEmail(to: string) {
  return {
    to,
    subject: `Two-step verification was turned off for your ${brand.name} account`,
    text: [
      `Two-step verification was just turned off for your ${brand.name} account, and you were signed out of your other devices.`,
      ``,
      `Signing in now needs only your password. You can turn it back on from your account page.`,
      ``,
      SECURITY_ADVICE,
    ].join("\n"),
  };
}

export function recoveryCodeUsedEmail(to: string, remaining: number) {
  return {
    to,
    subject: `A recovery code was used to sign in to your ${brand.name} account`,
    text: [
      `A recovery code was just used to sign in to your ${brand.name} account. Each code works once; you have ${remaining} left.`,
      ``,
      remaining <= 2
        ? `You are running low. Sign in and generate new recovery codes from your account page.`
        : `If you lost your authenticator, set up a new one from your account page.`,
      ``,
      SECURITY_ADVICE,
    ].join("\n"),
  };
}

export function recoveryCodesReplacedEmail(to: string) {
  return {
    to,
    subject: `New recovery codes were created for your ${brand.name} account`,
    text: [
      `A new set of recovery codes was just created for your ${brand.name} account. The old codes no longer work.`,
      ``,
      SECURITY_ADVICE,
    ].join("\n"),
  };
}

export function passwordChangedEmail(to: string) {
  return {
    to,
    subject: `Your ${brand.name} password was changed`,
    text: [
      `The password for your ${brand.name} account was just changed, and you were signed out of your other devices.`,
      ``,
      `If this was you, there is nothing to do. If it wasn't, reset your password straight away at ${appUrl()}/forgot-password and tell your school administrator.`,
    ].join("\n"),
  };
}

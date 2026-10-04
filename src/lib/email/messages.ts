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

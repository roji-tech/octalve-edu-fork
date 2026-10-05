import { brand } from "@/lib/brand";

// Plain-text messages: accessible everywhere, nothing to track or render wrongly.

import { RESET_LINK_MINUTES } from "@/lib/auth/reset-constants";
import { EMAIL_CHANGE_LINK_MINUTES } from "@/lib/auth/email-change";
import { maskEmail } from "@/lib/auth/mask-email";

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

// --- Change email (plan §0.5.E) ------------------------------------------------------------------------------

/// To the NEW address: following it proves the address is reachable. (Token in the URL fragment, like a reset.)
export function emailChangeConfirmEmail(to: string, token: string) {
  return {
    to,
    subject: `Confirm your new ${brand.name} email address`,
    text: [
      `Someone asked to use this address for a ${brand.name} account.`,
      ``,
      `To confirm it, open this link within ${EMAIL_CHANGE_LINK_MINUTES} minutes:`,
      `${appUrl()}/confirm-email#token=${token}`,
      ``,
      `Confirming signs the account out of every device, and from then on you sign in with this address.`,
      `If you didn't ask for this, ignore this message — nothing changes and the link stops working by itself.`,
    ].join("\n"),
  };
}

/// To the OLD address when a change is requested: they can stop it by changing their password.
export function emailChangeRequestedNotice(to: string, newEmail: string) {
  return {
    to,
    subject: `A change of email address was requested on your ${brand.name} account`,
    text: [
      `Someone who is signed in to your ${brand.name} account asked to change its email address to ${maskEmail(newEmail)}.`,
      ``,
      `Nothing changes until the link sent to that address is opened. This address keeps working until then.`,
      ``,
      `If this wasn't you, change your password straight away at ${appUrl()}/forgot-password and tell your school administrator.`,
    ].join("\n"),
  };
}

/// To the OLD address once it has happened.
export function emailChangedNotice(to: string, newEmail: string) {
  return {
    to,
    subject: `The email address on your ${brand.name} account was changed`,
    text: [
      `The email address on your ${brand.name} account was just changed to ${maskEmail(newEmail)}, and the account was signed out of every device.`,
      ``,
      `This address no longer signs in. If this wasn't you, contact your school administrator straight away.`,
    ].join("\n"),
  };
}

/// To an address that ALREADY has an account, when someone asks to use it for another account. (It is sent instead
/// of the confirmation link; the requester is told the same thing whether or not this happened.)
export function emailChangeTakenNotice(to: string) {
  return {
    to,
    subject: `Someone tried to use your email address on ${brand.name}`,
    text: [
      `Someone asked to use this address for a different ${brand.name} account. Because this address already has an account, nothing was changed and no link was sent.`,
      ``,
      `If that was you, you can simply sign in at ${appUrl()}/login (or reset your password at ${appUrl()}/forgot-password). If it wasn't, you can ignore this message.`,
    ].join("\n"),
  };
}

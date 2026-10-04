"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import {
  FACTOR_FORMAT_ERROR,
  FactorModeToggle,
  SecondFactorField,
  factorPayload,
  type FactorMode,
} from "@/components/auth/SecondFactorField";
import { brand } from "@/lib/brand";
import { RECOVERY_CODE_COUNT } from "@/lib/auth/mfa/codes";

// The "Two-step verification" panel of the account page (plan §0.5.D): turn it on (password → scan → confirm
// → save recovery codes), see its state, replace recovery codes, turn it off. Every action that changes
// anything re-asks for something an attacker holding only a stolen session would not have.

type View = "off" | "password" | "scan" | "codes" | "on" | "regen" | "disable";
type Reply = { ok: boolean; status: number; code?: string; message?: string; data?: Record<string, unknown> };

async function post(path: string, body: unknown): Promise<Reply> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, code: json?.error?.code, message: json?.error?.message, data: json?.data };
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }
}

const NETWORK_ERROR = "Can't reach the server. Check your internet connection and try again.";
const GENERIC_ERROR = "That didn't work. Please try again in a moment.";

/// A heading that takes focus when it appears after the person acted (never on first load), so keyboard and
/// screen-reader users land on the new state instead of on a button that just vanished.
function ViewHeading({ children, focus }: { children: ReactNode; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h3 ref={ref} tabIndex={-1} className="text-base font-semibold text-fg focus:outline-none">
      {children}
    </h3>
  );
}

function StatusBadge({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
        on ? "border-ok-line bg-ok-bg text-ok-fg" : "border-line bg-surface-2 text-fg-2"
      }`}
    >
      {on ? "On" : "Off"}
    </span>
  );
}

function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3 pt-1">{children}</div>;
}

export function TwoStepPanel({
  available,
  enabled,
  recoveryCodesRemaining,
}: {
  /// False when the server has no MFA_ENCRYPTION_KEY: the feature can't be used on this installation.
  available: boolean;
  enabled: boolean;
  recoveryCodesRemaining: number;
}) {
  const [view, setView] = useState<View>(enabled ? "on" : "off");
  const [touched, setTouched] = useState(false); // has the person done anything yet? (focus management)
  const [remaining, setRemaining] = useState(recoveryCodesRemaining);
  const [notice, setNotice] = useState<string | null>(null);
  // Held only while they are needed on screen, never persisted.
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [codesIntro, setCodesIntro] = useState<string | null>(null);

  function go(next: View) {
    setTouched(true);
    setView(next);
  }

  if (!available) {
    return (
      <div className="mt-4">
        <Alert variant="info">
          Two-step verification isn&apos;t available on this installation yet. Ask your administrator to set it
          up.
        </Alert>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-5">
      {notice && <Alert variant="success">{notice}</Alert>}

      {view === "off" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <ViewHeading focus={touched}>Status</ViewHeading>
            <StatusBadge on={false} />
          </div>
          <p className="max-w-prose text-sm text-fg-muted">
            Use an authenticator app (such as Google Authenticator, Microsoft Authenticator, 1Password or Authy)
            to generate a 6-digit code every time you sign in.
          </p>
          <Button
            onClick={() => {
              setNotice(null);
              go("password");
            }}
          >
            Set up two-step verification
          </Button>
        </div>
      )}

      {view === "password" && (
        <PasswordStep
          onCancel={() => go("off")}
          onStarted={(started) => {
            setSetup(started);
            go("scan");
          }}
        />
      )}

      {view === "scan" && setup && (
        <ScanStep
          setup={setup}
          onCancel={() => {
            setSetup(null);
            go("off");
          }}
          onConfirmed={(recoveryCodes) => {
            setSetup(null);
            setCodes(recoveryCodes);
            setCodesIntro("Two-step verification is on. You were signed out of your other devices.");
            go("codes");
          }}
        />
      )}

      {view === "codes" && codes && (
        <RecoveryCodes
          codes={codes}
          intro={codesIntro}
          onDone={() => {
            setRemaining(codes.length);
            setCodes(null);
            setCodesIntro(null);
            go("on");
          }}
        />
      )}

      {view === "on" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <ViewHeading focus={touched}>Status</ViewHeading>
            <StatusBadge on />
          </div>
          <p className="text-sm text-fg-muted">
            Signing in needs a code from your authenticator app as well as your password.
          </p>
          <p className="text-sm text-fg-2">
            <strong className="font-semibold text-fg">
              {remaining} of {RECOVERY_CODE_COUNT}
            </strong>{" "}
            recovery codes left.
          </p>
          {remaining <= 2 && (
            <Alert variant="warning" title={remaining === 0 ? "You have no recovery codes left" : "You're running low on recovery codes"}>
              If you lose your authenticator you could be locked out. Generate a new set below.
            </Alert>
          )}
          <FormActions>
            <Button
              variant="secondary"
              onClick={() => {
                setNotice(null);
                go("regen");
              }}
            >
              Generate new recovery codes
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setNotice(null);
                go("disable");
              }}
            >
              Turn off two-step verification
            </Button>
          </FormActions>
        </div>
      )}

      {view === "regen" && (
        <RegenerateForm
          onCancel={() => go("on")}
          onDone={(recoveryCodes) => {
            setCodes(recoveryCodes);
            setCodesIntro("Your new recovery codes are below. The old ones no longer work.");
            go("codes");
          }}
        />
      )}

      {view === "disable" && (
        <DisableForm
          onCancel={() => go("on")}
          onDone={() => {
            setNotice("Two-step verification is off. You were signed out of your other devices.");
            go("off");
          }}
        />
      )}
    </div>
  );
}

// --- Turn on, step 1: confirm the password ---------------------------------------------------------------

function PasswordStep({
  onCancel,
  onStarted,
}: {
  onCancel: () => void;
  onStarted: (setup: { secret: string; otpauthUrl: string }) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    if (!password) return setError("Enter your password.");
    setError(null);

    setPending(true);
    const reply = await post("/api/v1/auth/mfa/enroll", { password });
    setPending(false);
    if (reply.ok && typeof reply.data?.secret === "string" && typeof reply.data.otpauthUrl === "string") {
      return onStarted({ secret: reply.data.secret, otpauthUrl: reply.data.otpauthUrl });
    }
    setPassword("");
    if (reply.code === "INVALID_PASSWORD") setError(reply.message ?? "Your password is incorrect.");
    else if (reply.status === 429) setFormError("Too many attempts. Please wait a few minutes and try again.");
    else if (reply.status === 401) setFormError("Your session has ended. Please sign in again.");
    else if (reply.status === 503) setFormError("Two-step verification is unavailable right now.");
    else if (reply.code === "ALREADY_ENABLED") setFormError(reply.message ?? GENERIC_ERROR);
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  return (
    <form method="post" onSubmit={submit} noValidate className="max-w-md space-y-4">
      <ViewHeading focus>Confirm it&apos;s you</ViewHeading>
      <p className="text-sm text-fg-muted">Enter your password to start setting up two-step verification.</p>
      <PasswordField
        label="Password"
        name="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (error) setError(null);
        }}
        error={error}
        autoComplete="current-password"
        maxLength={128}
        disabled={pending}
      />
      {formError && <Alert variant="error">{formError}</Alert>}
      <FormActions>
        <Button type="submit" loading={pending}>
          {pending ? "Checking…" : "Continue"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </FormActions>
    </form>
  );
}

// --- Turn on, step 2: scan the QR code and confirm with a code -------------------------------------------

/// Copies text if the browser allows it (the clipboard API needs a secure context — plain-HTTP LAN installs
/// don't have one). Says so instead of failing silently.
function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return { state, copy };
}

function ScanStep({
  setup,
  onCancel,
  onConfirmed,
}: {
  setup: { secret: string; otpauthUrl: string };
  onCancel: () => void;
  onConfirmed: (recoveryCodes: string[]) => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { state: copyState, copy } = useCopy();

  // The QR code is drawn HERE, in the browser, from the otpauth:// URL: the secret is never sent to an
  // image service. (Dynamic import: the library is only fetched on this screen.)
  useEffect(() => {
    let cancelled = false;
    import("qrcode")
      .then((mod) =>
        (mod.default ?? mod).toDataURL(setup.otpauthUrl, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 208,
          // Always dark-on-white, in both themes — scanners need the contrast and the quiet zone.
          color: { dark: "#000000", light: "#ffffff" },
        }),
      )
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setup.otpauthUrl]);

  const grouped = setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const payload = factorPayload("code", code);
    if (!payload) return setError(code.trim() ? FACTOR_FORMAT_ERROR.code : "Enter the 6-digit code.");
    setError(null);

    setPending(true);
    const reply = await post("/api/v1/auth/mfa/confirm", payload);
    setPending(false);
    if (reply.ok && Array.isArray(reply.data?.recoveryCodes)) {
      return onConfirmed(reply.data.recoveryCodes as string[]);
    }
    setCode("");
    if (reply.code === "INVALID_CODE") {
      setError("That code isn't right. Wait for your app to show a new one and try again.");
    } else if (reply.status === 429) setFormError("Too many attempts. Please wait a few minutes and try again.");
    else if (reply.status === 401) setFormError("Your session has ended. Please sign in again.");
    else if (reply.code === "NOT_ENROLLING") setFormError("This setup has expired. Cancel and start again.");
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  return (
    <form method="post" onSubmit={submit} noValidate className="space-y-5">
      <ViewHeading focus>Set up your authenticator app</ViewHeading>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted marker:text-fg-muted">
        <li>Open your authenticator app and add a new account.</li>
        <li>Scan this QR code — or choose &ldquo;enter a setup key&rdquo; and type the key below.</li>
        <li>Type the 6-digit code your app now shows, and press Turn on.</li>
      </ol>

      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="flex h-[208px] w-[208px] shrink-0 items-center justify-center rounded-xl border border-line bg-white">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn in this browser
            <img src={qr} alt="QR code to add this account to your authenticator app" width={208} height={208} />
          ) : qrFailed ? (
            <p className="px-4 text-center text-xs text-neutral-700">
              The QR code couldn&apos;t be drawn. Use the setup key instead.
            </p>
          ) : (
            <p className="text-xs text-neutral-700">Drawing QR code…</p>
          )}
        </div>

        <div className="min-w-0 space-y-2">
          <p className="text-xs font-semibold tracking-wide text-fg-2 uppercase">Setup key</p>
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm tracking-wider break-all text-fg select-all">
            {grouped}
          </p>
          <div className="flex flex-wrap items-center gap-x-3">
            <Button variant="secondary" onClick={() => void copy(setup.secret)} className="min-h-11">
              Copy key
            </Button>
            <span role="status" className="text-xs text-fg-muted">
              {copyState === "copied" && "Copied."}
              {copyState === "failed" && "Couldn't copy here — select the key and copy it."}
            </span>
          </div>
          <p className="text-xs text-fg-muted">Time-based, 6 digits. Keep this key private.</p>
        </div>
      </div>

      <div className="max-w-md">
        <TextField
          label="Authentication code"
          name="code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (error) setError(null);
          }}
          error={error}
          hint="The 6-digit code from your authenticator app."
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={7}
          placeholder="123456"
          disabled={pending}
          className="tracking-[0.3em] tabular-nums"
        />
      </div>
      {formError && <Alert variant="error">{formError}</Alert>}
      <FormActions>
        <Button type="submit" loading={pending}>
          {pending ? "Checking…" : "Turn on"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </FormActions>
    </form>
  );
}

// --- Recovery codes (shown once) --------------------------------------------------------------------------

function RecoveryCodes({
  codes,
  intro,
  onDone,
}: {
  codes: string[];
  intro: string | null;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const { state: copyState, copy } = useCopy();
  const text = codes.join("\n");

  function download() {
    const body = `${brand.name} recovery codes\n\nEach code works once. Keep them somewhere safe.\n\n${text}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "recovery-codes.txt";
    document.body.appendChild(link); // some browsers only honour a click on an attached element
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="space-y-4">
      {intro && <Alert variant="success">{intro}</Alert>}
      <ViewHeading focus>Save your recovery codes</ViewHeading>
      <Alert variant="warning">
        Each code works once, and they will not be shown again. If you lose your authenticator, a recovery code is
        the only way back in — store them somewhere safe (a password manager, or printed).
      </Alert>
      <ul className="grid max-w-md grid-cols-2 gap-2 rounded-xl border border-line bg-surface-2 p-4 font-mono text-sm tracking-wider text-fg">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="secondary" onClick={() => void copy(text)}>
          Copy codes
        </Button>
        <Button variant="secondary" onClick={download}>
          Download as text file
        </Button>
        <span role="status" className="text-xs text-fg-muted">
          {copyState === "copied" && "Copied."}
          {copyState === "failed" && "Couldn't copy here — select the codes and copy them."}
        </span>
      </div>
      <CheckboxField
        name="saved"
        label="I have saved my recovery codes"
        checked={saved}
        onChange={(e) => setSaved(e.target.checked)}
      />
      <Button onClick={onDone} disabled={!saved}>
        Done
      </Button>
    </div>
  );
}

// --- Replace recovery codes ---------------------------------------------------------------------------------

function RegenerateForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (codes: string[]) => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const payload = factorPayload("code", code);
    if (!payload) return setError(code.trim() ? FACTOR_FORMAT_ERROR.code : "Enter the 6-digit code.");
    setError(null);

    setPending(true);
    const reply = await post("/api/v1/auth/mfa/recovery-codes", payload);
    setPending(false);
    if (reply.ok && Array.isArray(reply.data?.recoveryCodes)) return onDone(reply.data.recoveryCodes as string[]);
    setCode("");
    if (reply.code === "INVALID_CODE") setError("That code isn't right. Wait for your app to show a new one and try again.");
    else if (reply.status === 429) setFormError("Too many attempts. Please wait a few minutes and try again.");
    else if (reply.status === 401) setFormError("Your session has ended. Please sign in again.");
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  return (
    <form method="post" onSubmit={submit} noValidate className="max-w-md space-y-4">
      <ViewHeading focus>Generate new recovery codes</ViewHeading>
      <p className="text-sm text-fg-muted">
        This replaces all your current recovery codes — the old ones stop working. Enter a code from your
        authenticator app to continue.
      </p>
      <TextField
        label="Authentication code"
        name="code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          if (error) setError(null);
        }}
        error={error}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={7}
        placeholder="123456"
        disabled={pending}
        className="tracking-[0.3em] tabular-nums"
      />
      {formError && <Alert variant="error">{formError}</Alert>}
      <FormActions>
        <Button type="submit" loading={pending}>
          {pending ? "Checking…" : "Generate new codes"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </FormActions>
    </form>
  );
}

// --- Turn off -----------------------------------------------------------------------------------------------

function DisableForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<FactorMode>("code");
  const [factor, setFactor] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [factorError, setFactorError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [switched, setSwitched] = useState(false); // focus the factor field only after the person flips it

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const payload = factorPayload(mode, factor);
    const noPassword = password ? null : "Enter your password.";
    const noFactor = payload ? null : factor.trim() ? FACTOR_FORMAT_ERROR[mode] : mode === "code" ? "Enter the 6-digit code." : "Enter a recovery code.";
    setPasswordError(noPassword);
    setFactorError(noFactor);
    if (noPassword || noFactor || !payload) return;

    setPending(true);
    const reply = await post("/api/v1/auth/mfa/disable", { password, ...payload });
    setPending(false);
    if (reply.ok) return onDone();
    setPassword("");
    setFactor("");
    if (reply.code === "INVALID_PASSWORD") setPasswordError(reply.message ?? "Your password is incorrect.");
    else if (reply.code === "INVALID_CODE") {
      setFactorError(mode === "code" ? "That code isn't right. Wait for your app to show a new one and try again." : "That recovery code isn't right, or it has already been used.");
    } else if (reply.status === 429) setFormError("Too many attempts. Please wait a few minutes and try again.");
    else if (reply.status === 401) setFormError("Your session has ended. Please sign in again.");
    else if (reply.code === "NOT_ENABLED") setFormError("Two-step verification is already off.");
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  return (
    <form method="post" onSubmit={submit} noValidate className="max-w-md space-y-4">
      <ViewHeading focus>Turn off two-step verification</ViewHeading>
      <p className="text-sm text-fg-muted">
        Signing in will need only your password again, and you&apos;ll be signed out of your other devices. To
        make sure it&apos;s you, enter your password and a current code.
      </p>
      <PasswordField
        label="Password"
        name="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          if (passwordError) setPasswordError(null);
        }}
        error={passwordError}
        autoComplete="current-password"
        maxLength={128}
        disabled={pending}
      />
      <SecondFactorField
        mode={mode}
        value={factor}
        onChange={(next) => {
          setFactor(next);
          if (factorError) setFactorError(null);
        }}
        error={factorError}
        disabled={pending}
        autoFocus={switched}
      />
      <FactorModeToggle
        mode={mode}
        disabled={pending}
        onChange={(next) => {
          setMode(next);
          setFactor("");
          setFactorError(null);
          setSwitched(true);
        }}
      />
      {formError && <Alert variant="error">{formError}</Alert>}
      <FormActions>
        <Button type="submit" variant="danger" loading={pending}>
          {pending ? "Turning off…" : "Turn off"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </FormActions>
    </form>
  );
}

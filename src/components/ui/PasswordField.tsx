"use client";

import { useId, useState } from "react";
import { TextField, type TextFieldProps } from "./TextField";
import { EyeIcon, EyeOffIcon } from "./icons";

/// TextField + a show/hide toggle. The toggle is a real button (keyboard
/// reachable, aria-pressed, aria-controls the input) with a label that says
/// what will happen — not just an icon. Show/hide is a usability AND
/// accessibility win: typos in hidden passwords are the top cause of failed
/// sign-ins, and 128-char passphrases are impossible to verify blind.
export function PasswordField({ id, ...props }: Omit<TextFieldProps, "type" | "trailing">) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [visible, setVisible] = useState(false);

  return (
    <TextField
      {...props}
      id={inputId}
      type={visible ? "text" : "password"}
      autoCapitalize="none"
      spellCheck={false}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          aria-controls={inputId}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
        >
          {visible ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
        </button>
      }
    />
  );
}

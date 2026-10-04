"use client";

import { Button } from "@/components/ui/Button";
import { LogOutIcon } from "@/components/ui/icons";
import { useSignOut } from "./useSignOut";

export function SignOutButton() {
  const { signOut, pending, error } = useSignOut();

  return (
    <div className="flex items-center gap-3">
      {error && (
        <span role="alert" className="text-xs font-medium text-danger-text">
          {error}
        </span>
      )}
      <Button variant="secondary" loading={pending} onClick={signOut}>
        {!pending && <LogOutIcon className="h-4 w-4" />}
        {/* Icon-only on narrow phones (the label stays for assistive tech): with the brand, Account and
            the theme toggle there is no room for the word, and it used to wrap onto two lines. */}
        <span className="sr-only whitespace-nowrap sm:not-sr-only">Sign out</span>
      </Button>
    </div>
  );
}

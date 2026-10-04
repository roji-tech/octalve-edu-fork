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
        Sign out
      </Button>
    </div>
  );
}

import type { ReactNode } from "react";
import { AlertTriangleIcon, CheckCircleIcon, InfoIcon } from "./icons";

type Variant = "error" | "warning" | "info" | "success";

const STYLES: Record<Variant, { box: string; icon: string; Icon: typeof InfoIcon }> = {
  error: {
    box: "border-danger-line bg-danger-bg text-danger-fg",
    icon: "text-danger-icon",
    Icon: AlertTriangleIcon,
  },
  warning: {
    box: "border-warn-line bg-warn-bg text-warn-fg",
    icon: "text-warn-icon",
    Icon: AlertTriangleIcon,
  },
  info: {
    box: "border-info-line bg-info-bg text-info-fg",
    icon: "text-info-icon",
    Icon: InfoIcon,
  },
  success: {
    box: "border-ok-line bg-ok-bg text-ok-fg",
    icon: "text-ok-icon",
    Icon: CheckCircleIcon,
  },
};

/// Errors and warnings use role="alert" (announced immediately by screen
/// readers); info/success use role="status" (announced politely, without
/// interrupting). Never rely on colour alone — every variant also has an icon
/// and readable text.
export function Alert({
  variant,
  title,
  children,
  className = "",
  id,
  announce = true,
}: {
  variant: Variant;
  title?: string;
  children?: ReactNode;
  className?: string;
  id?: string;
  /// `false` for an alert that sits INSIDE a live region the caller already owns (a persistent `role="status"` container whose
  /// content changes): a second role on the content would make some screen readers announce it twice.
  announce?: boolean;
}) {
  const { box, icon, Icon } = STYLES[variant];
  const assertive = variant === "error" || variant === "warning";

  return (
    <div
      id={id}
      role={announce ? (assertive ? "alert" : "status") : undefined}
      className={`flex gap-3 rounded-xl border p-4 text-sm leading-relaxed ${box} ${className}`}
    >
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${icon}`} />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-0.5 opacity-90" : ""}>{children}</div>}
      </div>
    </div>
  );
}

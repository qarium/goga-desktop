import type { MouseEventHandler, ReactNode } from "react";
import { TooltipButton } from "../ActionHint";

/** Compact Overview controls use the same hover, keyboard and disabled-state hints as the workspace toolbar. */
export function IconButton({
  label, hint, onClick, onDoubleClick, disabled = false, className = "ov-icon", children,
}: {
  label: string;
  hint?: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onDoubleClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return <TooltipButton
    buttonClassName={className}
    disabled={disabled}
    busy={false}
    label={label}
    tooltipLabel={hint || label}
    onClick={onClick}
    tabProps={{ onDoubleClick }}
    fitViewport
  >{children}</TooltipButton>;
}

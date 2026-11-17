import type { ButtonHTMLAttributes } from "react";
import "./RunActions.css";

/** Compact actions in the 44px context bar; status labels are not buttons. */
export function RunActionButton({
  label,
  title = label,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} type="button" aria-label={label} title={title}
    className={`run-action-button ${className}`.trim()} />;
}

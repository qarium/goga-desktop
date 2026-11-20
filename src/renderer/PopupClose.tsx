import { X } from "lucide-react";
import type { Ref } from "react";

/** A visible dismiss action; the owner retains its focus and busy-state rules. */
export function PopupClose({label, onClick, disabled, buttonRef}: {
  label: string; onClick: () => void; disabled?: boolean; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return <button ref={buttonRef} type="button" className="popup-close" aria-label={label} disabled={disabled} onClick={onClick}>
    <X size={16} aria-hidden="true" />
  </button>;
}

import { useLayoutEffect, useRef, type ReactNode } from "react";
import "./LoadingBoundary.css";

export function LoadingState({ label }: { label: string }) {
  return (
    <div
      className="loading-state"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loading-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

/** Presentation only: the owner settles all dependent requests for its context.
 * Keep children mounted so an update never destroys an editor or its draft. */
export function LoadingBoundary({
  pending,
  label,
  error,
  onRetry,
  retryLabel = "Повторить загрузку",
  children,
}: {
  pending: boolean;
  label: string;
  error?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  const focus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (pending && content.current?.contains(document.activeElement))
      focus.current = document.activeElement as HTMLElement;
    if (!pending && !error && focus.current) {
      const target = focus.current;
      focus.current = null;
      // Do not steal focus from navigation/close controls or a different section.
      if (
        document.activeElement === document.body &&
        target.isConnected &&
        target.getClientRects().length
      )
        target.focus({ preventScroll: true });
    }
  }, [pending, error]);
  return (
    <div className="loading-boundary" aria-busy={pending}>
      {pending ? (
        <LoadingState label={label} />
      ) : error ? (
        <div className="loading-error">
          <p className="error" role="alert">
            {error}
          </p>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
        </div>
      ) : null}
      <div
        className="loading-content"
        ref={content}
        hidden={pending || !!error}
        inert={pending || !!error}
      >
        {children}
      </div>
    </div>
  );
}

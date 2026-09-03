import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from './icons';

interface ReviewOverlayProps {
  title: string;
  /** One line under the title saying what the panel is for, in plain
   *  language — these panels hold the more technical readings. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A focused panel for the secondary readings — the evaluation graph, the
 * clock — that would otherwise compete with the board for a phone screen.
 *
 * Deliberately modal. These are things you open, read and dismiss, not
 * things you monitor while stepping through moves, and giving them a
 * permanent strip of the layout is what left the board at 130px.
 */
export default function ReviewOverlay({
  title,
  subtitle,
  onClose,
  children,
}: ReviewOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stopped here so the review screen's own arrow/Escape hotkeys
        // don't also fire while a panel is open.
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase: the window-level review hotkeys are bound on bubble,
    // so this has to run first to be able to stop them.
    window.addEventListener('keydown', onKey, true);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="overlay" onPointerDown={onClose}>
      <div
        className="overlay-panel glass"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
        // The backdrop closes on press; the panel must not inherit that.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="overlay-head">
          <div className="overlay-titles">
            <h2 className="overlay-title">{title}</h2>
            {subtitle && <p className="overlay-sub">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <IconClose />
          </button>
        </header>

        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from 'react';
import { IconClose } from './icons';

interface ReviewOverlayProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

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
        e.stopPropagation();
        onClose();
      }
    };
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

import type { ReactNode } from 'react';

export function Badge({
  tone,
  children,
}: {
  tone: 'teal' | 'orange' | 'red' | 'blue' | 'purple' | 'gray' | 'green';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Toast({
  message,
  tone,
  onClose,
}: {
  message: string | null;
  tone: 'error' | 'info' | 'ok';
  onClose: () => void;
}) {
  if (!message) return null;
  return (
    <div className={`toast toast-${tone}`} onClick={onClose}>
      {message}
    </div>
  );
}

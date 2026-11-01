import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export const cn = clsx;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60 brand-ring',
        {
          sm: 'h-9 px-3 text-sm',
          md: 'h-11 px-4 text-sm',
          lg: 'h-14 px-6 text-base',
        }[size],
        {
          primary: 'bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-600/25 hover:from-blue-500 hover:to-blue-500',
          brand: 'bg-brand text-brand-fg shadow-sm hover:brightness-110',
          secondary: 'border border-gray-200 bg-white text-gray-800 hover:bg-gray-50',
          ghost: 'text-gray-600 hover:bg-gray-100',
          danger: 'bg-red-600 text-white hover:bg-red-700',
        }[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
});

export function Field({ label, error, hint, children, className }: { label?: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      {label && <span className="mb-1.5 block text-sm font-medium text-gray-700">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-xs font-medium text-red-600">{error}</span> : hint ? <span className="mt-1 block text-xs text-gray-500">{hint}</span> : null}
    </label>
  );
}

const inputBase =
  'w-full rounded-xl border bg-white px-3.5 text-gray-900 placeholder:text-gray-400 transition focus:outline-none focus:ring-4 disabled:bg-gray-50';
const inputState = (invalid?: boolean) =>
  invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-100' : 'border-gray-300 focus:border-brand focus:ring-brand/15';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; icon?: ReactNode }>(function Input(
  { className, invalid, icon, ...rest },
  ref,
) {
  return (
    <div className="relative">
      {icon && <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-gray-400">{icon}</span>}
      <input ref={ref} className={cn(inputBase, inputState(invalid), 'h-12', icon && 'pl-10', className)} aria-invalid={invalid || undefined} {...rest} />
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(inputBase, inputState(), 'min-h-24 py-3', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(inputBase, inputState(), 'h-12 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-3 text-sm text-gray-700">
      <span className={cn('relative h-6 w-11 rounded-full transition', checked ? 'bg-emerald-600' : 'bg-gray-300')}>
        <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
      {label}
    </button>
  );
}

export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-zinc-200/70 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04),0_8px_24px_-12px_rgba(16,24,40,.08)]', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">{title}</h3>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const badgeColors: Record<string, string> = {
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  expired: 'bg-gray-100 text-gray-600 ring-gray-500/20',
  canceled: 'bg-gray-100 text-gray-600 ring-gray-500/20',
  refunded: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/20',
  on: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  off: 'bg-gray-100 text-gray-600 ring-gray-500/20',
};
export const statusLabel: Record<string, string> = {
  paid: 'Pago',
  pending: 'Pendente',
  expired: 'Expirado',
  canceled: 'Cancelado',
  refunded: 'Reembolsado',
  failed: 'Falhou',
};
export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', badgeColors[tone] ?? badgeColors.off)}>{children}</span>;
}
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={status}>{statusLabel[status] ?? status}</Badge>;

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-gray-400', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="h-7 w-7" />
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="mb-2 rounded-2xl bg-gray-100 p-3 text-gray-500">{icon}</div>
      <p className="font-semibold text-gray-900">{title}</p>
      {text && <p className="max-w-sm text-sm text-gray-500">{text}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  // Portal no <body>: evita que ancestrais com transform/animação prendam o position:fixed
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn('animate-fade-in max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'err' } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div className={cn('animate-fade-in fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg', toast.tone === 'ok' ? 'bg-zinc-900 text-zinc-50' : 'bg-red-600')}>
      {toast.msg}
    </div>
  ) : null;
  return { node, ok: (msg: string) => setToast({ msg, tone: 'ok' }), err: (msg: string) => setToast({ msg, tone: 'err' }) };
}

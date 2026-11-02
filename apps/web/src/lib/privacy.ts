import { useEffect, useState } from 'react';

/** "rhyancarlos72@gmail.com" → "rh•••••••72@g•••.com" */
export function maskEmail(email: string) {
  const [user, domain = ''] = email.split('@');
  if (!user) return email;
  const u = user.length <= 4 ? `${user[0]}•••` : `${user.slice(0, 2)}${'•'.repeat(Math.min(8, user.length - 4))}${user.slice(-2)}`;
  const [dName, ...rest] = domain.split('.');
  const d = dName ? `${dName[0]}•••${rest.length ? `.${rest.join('.')}` : ''}` : '';
  return d ? `${u}@${d}` : u;
}

const KEY = 'ck_hide_email';
const listeners = new Set<(v: boolean) => void>();
function read() {
  try {
    return localStorage.getItem(KEY) !== '0'; // padrão: escondido
  } catch {
    return true;
  }
}

/** Esconder/mostrar o e-mail do admin no painel (lembrado neste navegador e sincronizado entre as telas). */
export function useHideEmail() {
  const [hidden, setHidden] = useState(read);
  useEffect(() => {
    listeners.add(setHidden);
    return () => void listeners.delete(setHidden);
  }, []);
  const set = (v: boolean) => {
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l(v));
  };
  return { hidden, toggle: () => set(!hidden), show: (email: string) => (hidden ? maskEmail(email) : email) };
}

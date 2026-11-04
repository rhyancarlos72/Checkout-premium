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

const KEY = 'ck_privacy';
const listeners = new Set<(v: boolean) => void>();
function read() {
  try {
    return localStorage.getItem(KEY) === '1'; // padrão: tudo visível
  } catch {
    return false;
  }
}
/** Liga/desliga o borrão de dados sensíveis (classe no <html> + elementos marcados com .pv). */
const applyClass = (on: boolean) => document.documentElement.classList.toggle('privacy-on', on);
applyClass(read());

/**
 * Modo privado do painel (olhinho): esconde faturamento, vendas, nomes de produtos/clientes e o e-mail
 * de uma vez. Lembrado neste navegador e sincronizado entre as telas.
 */
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
    applyClass(v);
    listeners.forEach((l) => l(v));
  };
  return { hidden, toggle: () => set(!hidden), show: (email: string) => (hidden ? maskEmail(email) : email) };
}

export const usePrivacy = useHideEmail;

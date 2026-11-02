import { useQuery } from '@tanstack/react-query';
import { adminApi } from './api';

export interface Me {
  id: string;
  email: string;
  role: 'owner' | 'staff';
  defaultProvider: 'woovi' | 'efi' | null;
}

/** Usuário logado no painel e o papel dele (dono vê integrações; equipe, o restante). */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => adminApi.get<Me>('/me'), staleTime: 60_000 });
}

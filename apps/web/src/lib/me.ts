import { useQuery } from '@tanstack/react-query';
import { adminApi } from './api';

export interface Me {
  id: string;
  email: string;
  role: 'owner' | 'staff';
  /** dono da plataforma (Prime): gateways, taxas, produtores */
  superAdmin?: boolean;
  /** organização (produtor) de quem está logado */
  org?: { id: string; name: string; owner: boolean; sellingEnabled: boolean } | null;
  defaultProvider: 'woovi' | 'efi' | null;
}

/** Usuário logado no painel e o papel dele (dono vê integrações; equipe, o restante). */
export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => adminApi.get<Me>('/me'), staleTime: 60_000, retry: (n, e: any) => e?.status !== 403 && n < 2 });
}

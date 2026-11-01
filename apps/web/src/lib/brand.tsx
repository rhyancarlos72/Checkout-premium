import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useEffect } from 'react';
import { publicApi } from './api';
import { cn } from '@/components/ui';

export interface Brand {
  name: string;
  logoUrl: string;
  logoBg: boolean;
}
export const defaultBrand: Brand = { name: 'Checkout Premium', logoUrl: '', logoBg: false };

const KEY = 'brand:v1';
const cached = (): Brand | undefined => {
  try {
    const v = localStorage.getItem(KEY);
    return v ? { ...defaultBrand, ...JSON.parse(v) } : undefined;
  } catch {
    return undefined;
  }
};

/** Logo + nome do sistema. Fica salvo no navegador para não "piscar" a logo padrão ao abrir. */
export function useBrand(): Brand {
  const q = useQuery({ queryKey: ['brand'], queryFn: () => publicApi.get<Brand>('/brand'), initialData: cached, initialDataUpdatedAt: 0, staleTime: 60_000 });
  const brand = { ...defaultBrand, ...q.data };
  useEffect(() => {
    if (!q.data) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(q.data));
    } catch {
      /* navegador sem storage */
    }
  }, [q.data]);
  // ícone da aba do navegador
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    if (brand.logoUrl) {
      link.href = brand.logoUrl;
      link.removeAttribute('type');
    } else {
      link.href = '/favicon.svg';
      link.type = 'image/svg+xml';
    }
  }, [brand.logoUrl]);
  return brand;
}

/** Ícone da marca: a logo enviada em Configurações ou o ícone padrão. */
export function BrandMark({ brand, className, iconClassName, fallbackClassName }: { brand: Brand; className?: string; iconClassName?: string; fallbackClassName?: string }) {
  if (brand.logoUrl)
    return (
      <div className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-xl', brand.logoBg && 'bg-[#fff] p-1 shadow-sm', className)}>
        <img src={brand.logoUrl} alt={brand.name} className="h-full w-full object-contain" />
      </div>
    );
  return (
    <div className={cn('flex shrink-0 items-center justify-center rounded-xl', fallbackClassName ?? 'bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-600/30', className)}>
      <CreditCard className={cn('text-white', iconClassName)} />
    </div>
  );
}

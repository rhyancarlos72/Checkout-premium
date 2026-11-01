/** Link público do checkout: /checkout?produto_id=<código> (não expõe o nome do produto). */
export const checkoutPath = (code: string, extra = '') => `/checkout?produto_id=${encodeURIComponent(code)}${extra}`;
export const checkoutUrl = (code: string, extra = '') => `${window.location.origin}${checkoutPath(code, extra)}`;

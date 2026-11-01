# Deploy: Supabase + GitHub + Hostinger

## 1. Supabase

1. Crie um projeto em https://supabase.com.
2. Em **SQL Editor**, cole e execute `supabase/migrations/20261101000000_init.sql`.
3. Em **Authentication → Users → Add user**, crie seu usuário (e-mail + senha).
4. Torne-o administrador (SQL Editor):
   ```sql
   insert into public.admins (user_id) select id from auth.users where email = 'SEU_EMAIL';
   ```
5. Em **Authentication → Providers → Email**, desative “Allow new users to sign up” (só você entra no painel).
6. Em **Project Settings → API** copie: `Project URL`, `anon key` (pública) e `service_role key` (**secreta**).

## 2. GitHub

O repositório não contém credenciais. `.env`, certificados `.p12/.pem` e logs estão no `.gitignore`, e o CI falha se algum deles for commitado.

## 3. Hostinger (Node.js Web App — planos Business/Cloud — ou VPS)

**Node.js Web App (hPanel → Websites → Adicionar → Node.js App → importar do GitHub):**

| Campo | Valor |
|---|---|
| Versão do Node | 22 (mínimo 20) |
| Comando de build | `npm ci && npm run build` |
| Comando de start / arquivo de entrada | `npm start` (ou `apps/api/dist/server.js`) |
| Variáveis de ambiente | todas do `.env.example` (as `VITE_*` precisam existir **no build**) |

Depois, aponte o domínio/subdomínio (ex.: `checkout.seudominio.com.br`) e ative o SSL (HTTPS é obrigatório para os webhooks).

**VPS (alternativa):**
```bash
git clone https://github.com/SEU_USUARIO/checkout-premium.git && cd checkout-premium
cp .env.example .env && nano .env
npm ci && npm run build
npm i -g pm2 && pm2 start npm --name checkout -- start && pm2 save
# Nginx como proxy reverso para a porta 3000 + certbot para SSL
```

### Certificado da Efí
Converta o `.p12` em uma linha base64 e cole em `EFI_CERT_BASE64`:
```bash
base64 -w0 certificado.p12      # Linux
base64 -i certificado.p12       # macOS
```
Nunca coloque o certificado em `public_html` nem no repositório.

## 4. Gateways

**Woovi:** painel Woovi → API/Plugins → crie o AppID (`WOOVI_APP_ID`). Em Webhooks, crie um com o evento `OPENPIX:CHARGE_COMPLETED`, URL `https://SEU_DOMINIO/api/webhooks/woovi` e, no campo Authorization, o mesmo valor de `WOOVI_WEBHOOK_SECRET`.

**Efí:** crie a aplicação com escopos Pix (cob.write, cob.read, pix.read, webhook.write, webhook.read), baixe o certificado de produção, cadastre as variáveis e clique em **Painel → Integrações → Registrar webhook na Efí**.

> Os webhooks do sistema PHP antigo continuam apontando para o servidor antigo. Troque para as URLs novas só quando migrar o tráfego.

## 5. PayTracking

Use a URL, o token e o segredo da integração “Checkout próprio” em `PAYTRACKING_URL`, `PAYTRACKING_TOKEN`, `PAYTRACKING_SECRET`. Teste em **Integrações → Testar conexão** (nenhum evento vai para a Meta no teste).

## 6. Ambientes

Use três conjuntos separados: **desenvolvimento** (local, `EFI_SANDBOX=true`), **homologação** (branch `develop`, outro projeto Supabase) e **produção** (branch `main`). O CI (`.github/workflows/ci.yml`) roda typecheck, testes e build em todo push.

## 7. Jobs

Com `JOBS_ENABLED=true`, o servidor concilia pedidos pendentes com o gateway a cada 2 min, expira PIX vencidos e envia e-mails de recuperação. Se a hospedagem suspender o processo ocioso, crie um cron (hPanel → Avançado → Cron Jobs):
```bash
curl -s -X POST -H "x-cron-secret: SEU_CRON_SECRET" https://SEU_DOMINIO/api/jobs/run
```

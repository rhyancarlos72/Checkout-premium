# Deploy: Supabase + GitHub + Hostinger

## 1. Supabase

1. Crie um projeto em https://supabase.com.
2. Em **SQL Editor**, cole e execute, **nesta ordem**, os arquivos de `supabase/migrations/`:
   - `20261101000000_init.sql` (estrutura completa)
   - `20261102000000_product_number.sql` (ID numérico dos produtos: #1001, #1002…). Se você já rodou o primeiro antes, rode só este.
3. Em **Authentication → URL Configuration**:
   - **Site URL:** a URL do seu checkout (ex.: `https://checkout.seudominio.com.br`)
   - **Redirect URLs:** adicione `https://checkout.seudominio.com.br/admin/**`

   Sem isso, os links de e-mail (primeiro acesso / nova senha) levam para `localhost`.
4. Em **Project Settings → API** copie: `Project URL`, `anon key` (pública) e `service_role key` (**secreta**).
5. Depois do deploy (passo 3), crie seu acesso pelo próprio painel: defina `ADMIN_EMAIL` com seu e-mail, abra `/admin` → **Primeiro acesso? Criar minha conta** → abra o link que chega no e-mail → defina a senha.
6. Por fim, em **Authentication → Sign In / Providers → Email**, desative “Allow new users to sign up”.

Esqueceu a senha? Use **Esqueci minha senha** na tela de login.

**Verificação em 2 etapas (recomendado):** no painel, **Configurações → Segurança → Ativar**. Escaneie o QR Code com Google Authenticator, Authy ou 1Password. A partir daí, todo login pede o código de 6 dígitos, e o servidor recusa sessões sem essa verificação. O TOTP já vem ativo em todo projeto Supabase (Authentication → Multi-Factor).

> Os e-mails de autenticação saem pelo servidor de e-mail do Supabase, que tem limite baixo (poucos por hora). Se não chegarem, configure seu SMTP da Hostinger em **Authentication → Emails → SMTP Settings**.

## 2. GitHub

O repositório não contém credenciais. `.env`, certificados `.p12/.pem` e logs estão no `.gitignore`, e o CI falha se algum deles for commitado.

## 3. Hostinger (Node.js Web App — planos Business/Cloud — ou VPS)

**Node.js Web App (hPanel → Websites → Adicionar → Node.js App → importar do GitHub):**

| Campo | Valor |
|---|---|
| Framework | **Express** |
| Versão do Node | **22** |
| Gerenciador de pacotes | npm |
| Arquivo de entrada | `server.js` |

Não existe campo de build na Hostinger, e não precisa: o `npm install` dispara o build sozinho (script `postinstall`). Se por algum motivo o build não rodar, o `server.js` compila na primeira inicialização. Se mesmo assim algo der errado, o site mostra uma página de diagnóstico em vez de "503".

**Variáveis de ambiente obrigatórias:** `PUBLIC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` e `ADMIN_EMAIL` (para o primeiro acesso). As demais (Woovi, Efí, PayTracking, SMTP) podem ser adicionadas depois. Elas são lidas na inicialização, então depois de alterar variáveis basta reiniciar/redeploy.

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

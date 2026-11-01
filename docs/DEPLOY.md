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

**Variáveis de ambiente obrigatórias:** `PUBLIC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` e `ADMIN_EMAIL` (para o primeiro acesso). Woovi, Efí e PayTracking são configurados no painel (Integrações); SMTP pode ser adicionado depois. Elas são lidas na inicialização, então depois de alterar variáveis basta reiniciar/redeploy.

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

## 4. Gateways (pelo painel)

**Efí Bank:** painel → **Integrações → Efí Bank → Configurar**.
1. Na Efí, crie a aplicação com os escopos Pix (cob.write, cob.read, pix.read, webhook.write, webhook.read) e baixe o certificado **.p12** de produção.
2. No formulário: Client ID, Client Secret, Chave Pix e **envie o arquivo .p12** (senha só se o seu tiver; os da Efí normalmente não têm). O certificado é validado ao salvar.
3. Clique em **Salvar e testar** e depois em **Registrar webhook na Efí**.
Use “Homologação” para testar com as credenciais e o certificado de homologação.

**Woovi:** painel → **Integrações → Woovi → Configurar**. Cole o AppID e salve. No painel da Woovi → Webhooks, crie um webhook com o evento `OPENPIX:CHARGE_COMPLETED` e a URL mostrada. Recomendado: clique em **Gerar segredo do webhook** e cole o valor no campo *Authorization* desse webhook na Woovi.

As credenciais ficam no banco (tabela `settings`, só admins/servidor) e o painel só mostra os 4 últimos caracteres. As variáveis `WOOVI_*` / `EFI_*` continuam funcionando como alternativa; o que for salvo no painel tem prioridade.

> Os webhooks do sistema PHP antigo continuam apontando para o servidor antigo. Troque para as URLs novas só quando migrar o tráfego.

## 5. PayTracking (webhook)

No painel: **Integrações → Webhooks → Adicionar webhook → PayTracking**. A URL já vem preenchida; cole o **token** e o **segredo** da sua integração “Checkout próprio” e clique em **Testar** (o teste não registra venda nem envia nada à Meta).

- Eventos: Pix gerado (`sale.pending`), venda aprovada com order bumps (`sale.approved`), Pix expirado (`sale.canceled`) e reembolso (`sale.refunded`). Escolha quais enviar.
- Cada envio é assinado com HMAC-SHA256 (`X-Paytrack-Signature` + `X-Paytrack-Timestamp`) e tem novas tentativas em falha.
- Dá para adicionar outros webhooks (CRM, planilhas, automações) com o mesmo formato.
- Token e segredo ficam no banco (tabela `settings`, só admins/servidor) e o painel mostra apenas os 4 últimos caracteres.
- As variáveis `PAYTRACKING_*` continuam funcionando como alternativa; se existirem, aparecem na lista como “variáveis de ambiente”.

## 5.1 WhatsApp (Evolution API)

No painel: **Integrações → WhatsApp · Evolution API**.
1. Informe a **URL da Evolution API** (ex.: `http://SEU-IP:8082`).
2. Adicione as **instâncias** (nome + token). Clique em **Verificar conexão** para ver quais estão online.
3. Escolha o que enviar: **acesso quando o pagamento for aprovado** e/ou **recuperação de Pix pendente** (2 lembretes; padrão 20 min e 3 h, com o Pix copia e cola).
4. **Salvar WhatsApp** e use **Enviar teste** com o seu número.

As mensagens seguem o padrão cordial do checkout antigo (sem CAPS, sem urgência falsa, sem caracteres invisíveis, com “responda SAIR”), alternam entre as instâncias ativas, pulam as offline e não repetem o mesmo texto seguido na mesma instância. Tokens ficam no banco (só admins/servidor) e aparecem mascarados.

## 6. Ambientes

Use três conjuntos separados: **desenvolvimento** (local, `EFI_SANDBOX=true`), **homologação** (branch `develop`, outro projeto Supabase) e **produção** (branch `main`). O CI (`.github/workflows/ci.yml`) roda typecheck, testes e build em todo push.

## 7. Jobs

Com `JOBS_ENABLED=true`, o servidor concilia pedidos pendentes com o gateway a cada 2 min, expira PIX vencidos e envia e-mails de recuperação. Se a hospedagem suspender o processo ocioso, crie um cron (hPanel → Avançado → Cron Jobs):
```bash
curl -s -X POST -H "x-cron-secret: SEU_CRON_SECRET" https://SEU_DOMINIO/api/jobs/run
```

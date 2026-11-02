# Deploy: Supabase + GitHub + Hostinger

## 1. Supabase

1. Crie um projeto em https://supabase.com.
2. Em **SQL Editor**, cole e execute, **nesta ordem**, os arquivos de `supabase/migrations/`:
   - `20261101000000_init.sql` (estrutura completa)
   - `20261102000000_product_number.sql` (numeração interna dos produtos, base do **ID único de 7 dígitos**, ex.: `ID: 9452335`). Se você já rodou o primeiro antes, rode só este.
   - `20261103000000_performance_indexes.sql` (opcional, recomendado: índices que deixam painel e jobs mais rápidos).
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
2. Informe a **API Key global** da Evolution (`AUTHENTICATION_API_KEY`) e clique em **Buscar instâncias**: o painel puxa o nome exato, o status e o número de cada instância — marque as que quer usar e clique em **Importar**. (Também dá para cadastrar manualmente nome + token.)
3. Escolha o que enviar: **acesso quando o pagamento for aprovado** e/ou **recuperação de Pix pendente** (2 lembretes; padrão 20 min e 3 h, com o Pix copia e cola).
4. **Salvar WhatsApp** e use **Enviar teste** com o seu número.

As mensagens seguem o padrão cordial do checkout antigo (sem CAPS, sem urgência falsa, sem caracteres invisíveis, com “responda SAIR”), alternam entre as instâncias ativas, pulam as offline e não repetem o mesmo texto seguido na mesma instância. Tokens ficam no banco (só admins/servidor) e aparecem mascarados.

### Não está enviando? Use o **Diagnosticar agora**

| Mensagem no painel | O que fazer |
|---|---|
| Envio automático desativado | Ligue “Ativado” no topo da seção e salve |
| Tempo esgotado ao conectar | A hospedagem bloqueia a porta (ex.: 8082). Publique a Evolution num domínio **HTTPS (porta 443)** com proxy reverso e use essa URL |
| Conexão recusada | Evolution parada ou porta errada |
| Token recusado (401/403) | Cole o **token (apikey)** da instância — não é o número do WhatsApp. A API Key global também funciona |
| Instância não encontrada / 404 ao enviar | Use **Buscar instâncias** e importe com o nome exato (a resposta da Evolution aparece na mensagem) |
| WhatsApp desconectado | Escaneie o QR Code da instância na Evolution |
| Número não tem WhatsApp | Confira DDD/número do cliente |
| Rotina parada há muito tempo | Crie o Cron Job de `/api/jobs/run` (seção 7) |

**URL com `/manager`:** o endereço do painel web da Evolution (ex.: `http://SEU-IP:8082/manager/`) não é a URL da API. O checkout já corrige sozinho para `http://SEU-IP:8082`.

**Hostinger bloqueando a porta 8082 (tempo esgotado):** rode na VPS da Evolution o script `docs/evolution-proxy.sh` (como root). Ele publica `https://SEU-IP-com-traços.sslip.io` com HTTPS grátis (Let’s Encrypt) apontando para a Evolution, e o checkout passa a usar esse endereço automaticamente quando `http://IP:8082` não responde.

Proxy reverso manual (Nginx na VPS da Evolution, com certificado do Let’s Encrypt):
```nginx
server {
  server_name evolution.seudominio.com;
  location / { proxy_pass http://127.0.0.1:8082; proxy_set_header Host $host; }
}
```

## 5.2 E-mail de recuperação (entrega na caixa de entrada)

O e-mail já sai com: versão em texto, assunto pessoal sem palavras de spam, Reply-To do suporte (Configurações → Loja → E-mail de suporte), descadastro de 1 clique (`List-Unsubscribe`, exigido por Gmail/Yahoo) e o nome da loja como remetente. Quem se descadastra deixa de receber a recuperação (o e-mail de acesso continua).

Para não cair no spam, faça **uma vez** no domínio (hPanel → Domínios → DNS / E-mails):
1. **E-mail no seu domínio:** crie `vendas@seudominio.com.br` no Hostinger Email e use em `SMTP_USER` e `MAIL_FROM` (nunca um @gmail).
2. **SPF:** registro TXT `v=spf1 include:_spf.mail.hostinger.com ~all` (a Hostinger cria ao ativar o e-mail; confira).
3. **DKIM:** hPanel → E-mails → Configurações de DNS → ativar DKIM.
4. **DMARC:** registro TXT em `_dmarc` com `v=DMARC1; p=none; rua=mailto:vendas@seudominio.com.br`.
5. Teste em https://www.mail-tester.com (envie o teste de Integrações → E-mail para o endereço que o site mostra); a meta é nota 9+.

## 6. Ambientes

Use três conjuntos separados: **desenvolvimento** (local, `EFI_SANDBOX=true`), **homologação** (branch `develop`, outro projeto Supabase) e **produção** (branch `main`). O CI (`.github/workflows/ci.yml`) roda typecheck, testes e build em todo push.

## 7. Jobs

Com `JOBS_ENABLED=true`, o servidor concilia pedidos pendentes com o gateway a cada 2 min, expira PIX vencidos e envia e-mails de recuperação. Se a hospedagem suspender o processo ocioso, crie um cron (hPanel → Avançado → Cron Jobs):
```bash
curl -s -X POST -H "x-cron-secret: SEU_CRON_SECRET" https://SEU_DOMINIO/api/jobs/run
```

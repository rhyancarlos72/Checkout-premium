# geo-br.bin

Cidade e estado (UF) por faixa de IP, só do Brasil, usados para a correspondência avançada da Meta
(Pixel e PayTracking) quando a hospedagem não envia cabeçalhos de localização.

- Fonte: **IP Geolocation by [DB-IP](https://db-ip.com)** — "IP to City Lite", licença
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Recortado para o Brasil.
- Nenhuma consulta externa: o servidor lê este arquivo (~4 MB) na inicialização.
- Atualizar (opcional, a DB-IP publica todo mês): veja `scripts/build-geo-br.mjs`.

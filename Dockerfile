# ============================================================
#  Gestão TI — imagem de produção
# ============================================================
# node:22-slim (não alpine) por causa do ICU completo: hojeEmSaoPaulo() e as
# datas dos e-mails usam Intl com timeZone 'America/Sao_Paulo'. Com ICU
# reduzido o Intl cai silenciosamente para UTC e os lembretes do calendário
# saem no dia errado.
FROM node:22-slim

ENV NODE_ENV=production
# TZ fica em UTC de propósito, igual ao ambiente atual: o código mistura
# SYSUTCDATETIME(), GETDATE() (fuso da máquina do SQL Server) e new Date().
# Trocar o fuso é tarefa separada da migração.
ENV TZ=UTC

WORKDIR /app

# Camada de dependências separada: só refaz o npm ci quando o lock muda.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./server/
COPY public/ ./public/

# A imagem node já traz o usuário "node" (uid 1000).
USER node

EXPOSE 3000

CMD ["node", "server/index.js"]

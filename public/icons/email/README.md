# Ícones do e-mail de chamado

PNGs usados por `server/emailChamado.js` no e-mail que vai para o solicitante.

## Por que PNG, e não Phosphor direto

O portal usa Phosphor via CDN, mas isso não sobrevive em e-mail:

- webfont externa é bloqueada pela maioria dos clientes;
- `<svg>` inline o Gmail remove do HTML;
- `data:` URI em `<img>` o Gmail bloqueia.

Sobra PNG hospedado, servido do mesmo domínio que já entrega o `logo_intecs.png`.

## Fundo assado no arquivo

Cada PNG já vem com o fundo sobre o qual aparece — branco para os ícones do grid,
`#F5F4F8` para os que ficam dentro de card. PNG com transparência não é confiável no
Outlook, então a cor vai no arquivo em vez de vir do CSS.

**Se mudar `P.cartao` em `emailChamado.js`, estes PNGs precisam ser gerados de novo.**

## Tamanhos

Cada arquivo tem o dobro do tamanho de exibição, para não borrar em tela retina:

| Arquivo | Fonte | Exibido | Onde |
|---|---|---|---|
| `topo.png` | 112px | 56px | tile ao lado da manchete |
| `chamado.png` | 88px | 44px | tile do card do chamado |
| demais | 44px | 22px | rótulos do grid, prazo, evento |

## Como regerar

Os arquivos foram capturados de uma página que renderiza o Phosphor pelo CDN, um
elemento por ícone, com o fundo certo em cada caixa. Com `playwright-cli`:

```bash
playwright-cli open http://localhost:3210/gerar-icones.html
playwright-cli screenshot "#ic-solicitante" --filename solicitante.png --hires
```

O arquivo sai no diretório de trabalho, não em `.playwright-cli/`.

Ícones em uso: `ph-fill ph-headset` (topo), `ph-fill ph-clipboard-text` (chamado) e,
em `ph-bold`: `ph-user`, `ph-laptop`, `ph-buildings`, `ph-user-circle`,
`ph-list-dashes`, `ph-clock`, `ph-calendar-blank`, `ph-chat-circle-dots`,
`ph-arrows-clockwise`. Cor `#5B45E0`, o índigo do portal.

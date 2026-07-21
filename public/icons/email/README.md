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
| `topo-*.png` | 112px | 56px | tile ao lado da manchete |
| `chamado.png` | 88px | 44px | tile do card do chamado |
| demais | 44px | 22px | rótulos do grid, prazo, evento |

## Tiles do topo, um por evento

O ícone e a cor do topo dizem o que aconteceu antes da pessoa ler o texto. As cores saem
da mesma paleta de status usada nos selos, então o topo nunca contradiz o selo logo abaixo.
`emailChamado.js` escolhe pelo parâmetro `tile`; valor desconhecido cai no `generico`.

| `tile` | Ícone | Cor | Quando |
|---|---|---|---|
| `recibo` | `ph-bell` | âmbar `#9A6700` / `#FCF3E0` | chamado aberto, recibo ao solicitante |
| `resposta` | `ph-chat-circle-dots` | índigo `#4A3BD1` / `#EDEBFA` | equipe comentou |
| `resolvido` | `ph-check-circle` | verde `#1A7F37` / `#E6F4EA` | status virou RESOLVIDO |
| `aguardando` | `ph-question` | laranja `#B4530F` / `#FAEEE1` | status pede ação do solicitante |
| `fechado` | `ph-archive` | neutro `#57534E` / `#EFEDE9` | status virou FECHADO |
| `cancelado` | `ph-x-circle` | vermelho `#B3261E` / `#FBECEA` | status virou CANCELADO |
| `generico` | `ph-arrows-clockwise` | índigo `#4A3BD1` / `#EDEBFA` | status customizado, sem tile próprio |

## Como regerar

Os arquivos foram capturados de uma página que renderiza o Phosphor pelo CDN, um
elemento por ícone, com o fundo certo em cada caixa. Com `playwright-cli`:

```bash
playwright-cli open http://localhost:3210/gerar-icones.html
playwright-cli screenshot "#ic-solicitante" --filename solicitante.png --hires
```

O arquivo sai no diretório de trabalho, não em `.playwright-cli/`.

Ícones em uso: `ph-fill ph-clipboard-text` (chamado), os tiles da tabela acima e,
em `ph-bold`: `ph-user`, `ph-laptop`, `ph-buildings`, `ph-user-circle`,
`ph-list-dashes`, `ph-clock`, `ph-calendar-blank`, `ph-chat-circle-dots`,
`ph-arrows-clockwise`. Cor `#5B45E0`, o índigo do portal.

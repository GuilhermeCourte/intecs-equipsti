// ============================================================
//  Seed de PERFORMANCE — 800 registros com 3 fotos cada
//  Fotos são BMPs válidos gerados em memória (sem dependências)
//  Leve ~5 KB | Média ~68 KB | Pesada ~271 KB por foto
//
//  Rodar:  node server/seed-performance.js
//  Limpar: DELETE FROM EQUIPSTI_registros WHERE pat LIKE 'SEED-PF-%'
// ============================================================
import dotenv from 'dotenv';
import { getPool, query, sql } from './db.js';

dotenv.config();

const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });

// ── Gerador de BMP (24-bit RGB, sem dependências) ──────────────────────────
function criarBMP(w, h, r, g, b) {
  const rowSize = Math.ceil((w * 3) / 4) * 4; // alinhado a 4 bytes
  const fileSize = 54 + rowSize * h;
  const buf = Buffer.alloc(fileSize, 0);

  // File header
  buf[0] = 0x42; buf[1] = 0x4d;        // 'BM'
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);            // offset dos pixels

  // DIB header (BITMAPINFOHEADER)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);             // planos de cor
  buf.writeUInt16LE(24, 28);            // bits por pixel
  buf.writeUInt32LE(0, 30);             // sem compressão
  buf.writeUInt32LE(rowSize * h, 34);
  buf.writeInt32LE(2835, 38);           // 72 dpi horizontal
  buf.writeInt32LE(2835, 42);           // 72 dpi vertical

  // Dados de pixel (BMP = BGR, linha de baixo para cima)
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const off = 54 + row * rowSize + col * 3;
      buf[off]     = b; // Blue
      buf[off + 1] = g; // Green
      buf[off + 2] = r; // Red
    }
  }

  return 'data:image/bmp;base64,' + buf.toString('base64');
}

// ── Pools de imagem ────────────────────────────────────────────────────────
//  LEVES  35×35  → ~3.7 KB raw  → ~5 KB base64   (tons de azul)
//  MEDIAS 130×130 → ~51 KB raw  → ~68 KB base64  (tons de verde)
//  PESADAS 260×260 → ~203 KB raw → ~271 KB base64 (tons de vermelho)

console.log('Gerando pool de imagens BMP...');

const LEVES = [
  criarBMP(35, 35,  70, 130, 230),  // cornflower blue
  criarBMP(35, 35,  30, 144, 255),  // dodger blue
  criarBMP(35, 35,   0, 191, 255),  // deep sky blue
  criarBMP(35, 35, 100, 149, 237),  // slate blue
  criarBMP(35, 35, 135, 206, 235),  // sky blue
];

const MEDIAS = [
  criarBMP(130, 130,  60, 179, 113), // medium sea green
  criarBMP(130, 130,  46, 139,  87), // sea green
  criarBMP(130, 130,   0, 168,  68), // green
  criarBMP(130, 130,  50, 205,  50), // lime green
  criarBMP(130, 130, 102, 205, 170), // medium aquamarine
];

const PESADAS = [
  criarBMP(260, 260, 220,  20,  60), // crimson
  criarBMP(260, 260, 255,  69,   0), // orange red
  criarBMP(260, 260, 255, 140,   0), // dark orange
  criarBMP(260, 260, 178,  34,  34), // firebrick
  criarBMP(260, 260, 255,  99,  71), // tomato
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── Dados de domínio ───────────────────────────────────────────────────────
const UNIDADES    = ['MATRIZ', 'FILIAL SP', 'FILIAL RJ', 'ALMOXARIFADO', 'CD CAMPINAS'];
const SETORES     = ['TI', 'ADMINISTRATIVO', 'FINANCEIRO', 'RH', 'LOGISTICA'];
const EQUIPS      = ['DESKTOP', 'NOTEBOOK', 'MONITOR', 'IMPRESSORA', 'SWITCH', 'SERVIDOR', 'TABLET'];
const STATUS_OPTS = ['ATIVO', 'INATIVO', 'EM MANUTENCAO', 'RESERVA'];
const USUARIOS    = ['ANA SILVA', 'CARLOS SOUZA', 'MARIA SANTOS', 'JOAO OLIVEIRA', 'LUCIA FERREIRA'];
const TIPOS       = ['COMPRADO', 'LOCADO'];

function dataAleatoria() {
  const ano = 2024;
  const mes = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const dia = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

async function main() {
  await getPool();

  // ── Limpeza ────────────────────────────────────────────────────────────
  console.log('Removendo registros de seed anteriores (SEED-PF-*)...');
  await query(`DELETE FROM dbo.EQUIPSTI_registros_log
    WHERE registro_id IN (SELECT id FROM dbo.EQUIPSTI_registros WHERE pat LIKE 'SEED-PF-%')`);
  await query("DELETE FROM dbo.EQUIPSTI_registros WHERE pat LIKE 'SEED-PF-%'");

  // ── Inserção ───────────────────────────────────────────────────────────
  const TOTAL = 800;
  const GRUPO = Math.ceil(TOTAL / 3); // ~267 por grupo

  console.log(`Inserindo ${TOTAL} registros (3 fotos cada)...`);
  console.log('  Grupo A (001-267): foto1=Leve  foto2=Média  foto3=Pesada');
  console.log('  Grupo B (268-534): foto1=Pesada foto2=Leve  foto3=Média');
  console.log('  Grupo C (535-800): foto1=Média  foto2=Pesada foto3=Leve');

  const t0 = Date.now();

  for (let i = 1; i <= TOTAL; i++) {
    const pat = 'SEED-PF-' + String(i).padStart(4, '0');
    const ns  = 'SN-SEED-'  + String(10000 + i);

    // Atribuição de tamanho por grupo (rotaciona entre os slots)
    let foto1, foto2, foto3;
    const g = Math.floor((i - 1) / GRUPO);
    if (g === 0) { foto1 = pick(LEVES);  foto2 = pick(MEDIAS);  foto3 = pick(PESADAS); }
    else if (g === 1) { foto1 = pick(PESADAS); foto2 = pick(LEVES);  foto3 = pick(MEDIAS); }
    else              { foto1 = pick(MEDIAS);  foto2 = pick(PESADAS); foto3 = pick(LEVES); }

    await query(`
      INSERT INTO dbo.EQUIPSTI_registros
        (unidade, status, setor, usuario, ns, pat, equipamento,
         tipo_aquisicao, protocolo, data_recebimento, valor, obs,
         imagem_base64, imagem2_base64, imagem3_base64, criado_por)
      VALUES
        (@unidade, @status, @setor, @usuario, @ns, @pat, @equip,
         @tipo, @protocolo, @dataRec, @valor, @obs,
         @img1, @img2, @img3, @criadoPor)`,
      {
        unidade:   S(UNIDADES[i % UNIDADES.length]),
        status:    S(STATUS_OPTS[i % STATUS_OPTS.length]),
        setor:     S(SETORES[i % SETORES.length]),
        usuario:   S(USUARIOS[i % USUARIOS.length]),
        ns:        S(ns),
        pat:       S(pat),
        equip:     S(EQUIPS[i % EQUIPS.length]),
        tipo:      S(TIPOS[i % TIPOS.length]),
        protocolo: S('PROT-' + String(i).padStart(4, '0')),
        dataRec:   S(dataAleatoria()),
        valor:     { type: sql.Decimal(15, 2), value: parseFloat((Math.random() * 9000 + 500).toFixed(2)) },
        obs:       S('Registro de performance test #' + i),
        img1:      S(foto1),
        img2:      S(foto2),
        img3:      S(foto3),
        criadoPor: S('seed-performance'),
      });

    if (i % 50 === 0 || i === TOTAL) {
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      const eta = i < TOTAL ? ` | ETA ~${((Date.now() - t0) / i * (TOTAL - i) / 1000).toFixed(0)}s` : '';
      process.stdout.write(`\r  ${i}/${TOTAL} inseridos  (${s}s${eta})   `);
    }
  }

  const total = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n--------------------------------------------------');
  console.log(`Concluído! ${TOTAL} registros em ${total}s.`);
  console.log('Tamanhos por foto:');
  console.log('  Leve   35×35  → ~5 KB base64');
  console.log('  Média  130×130 → ~68 KB base64');
  console.log('  Pesada 260×260 → ~271 KB base64');
  console.log(`  Total estimado no banco: ~${(TOTAL * (5 + 68 + 271) / 1024).toFixed(0)} MB`);
  console.log('--------------------------------------------------');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nErro:', err.message);
  process.exit(1);
});

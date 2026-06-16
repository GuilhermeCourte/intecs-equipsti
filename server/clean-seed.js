import dotenv from 'dotenv';
import { getPool, query, sql } from './db.js';

dotenv.config();

const S = (v) => ({ type: sql.NVarChar, value: v });

const SEED_OPCOES = {
  UNIDADE:     ['MATRIZ', 'FILIAL SP', 'FILIAL RJ', 'ALMOXARIFADO', 'CD CAMPINAS'],
  SETOR:       ['TI', 'ADMINISTRATIVO', 'FINANCEIRO', 'RH', 'LOGISTICA'],
  EQUIPAMENTO: ['DESKTOP', 'MONITOR', 'NOTEBOOK', 'IMPRESSORA', 'SWITCH'],
  STATUS:      ['ATIVO', 'INATIVO', 'EM MANUTENCAO'],
};

async function main() {
  await getPool();

  const e = await query("DELETE FROM dbo.EQUIPSTI_emprestimos WHERE pat LIKE 'PAT-%'");
  const r = await query("DELETE FROM dbo.EQUIPSTI_registros WHERE pat LIKE 'PAT-%'");
  console.log(`Removidos: ${e.rowsAffected[0]} empréstimos, ${r.rowsAffected[0]} registros.`);

  let totalOpcoes = 0;
  for (const [lista, valores] of Object.entries(SEED_OPCOES)) {
    for (const valor of valores) {
      const o = await query(
        "DELETE FROM dbo.EQUIPSTI_opcoes WHERE lista=@l AND valor=@v",
        { l: S(lista), v: S(valor) }
      );
      totalOpcoes += o.rowsAffected[0];
    }
  }
  console.log(`Removidas: ${totalOpcoes} opções.`);
  process.exit(0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });

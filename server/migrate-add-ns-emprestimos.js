import dotenv from 'dotenv';
import { getPool, query } from './db.js';

dotenv.config();

async function main() {
  await getPool();

  console.log('Adicionando coluna ns em EQUIPSTI_emprestimos...');
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'EQUIPSTI_emprestimos' AND COLUMN_NAME = 'ns'
    )
    ALTER TABLE dbo.EQUIPSTI_emprestimos ADD ns NVARCHAR(255) NULL;
  `);

  console.log('Coluna ns adicionada com sucesso.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});

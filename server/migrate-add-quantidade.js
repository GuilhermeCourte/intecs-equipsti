import dotenv from 'dotenv';
import { getPool, query } from './db.js';

dotenv.config();

async function main() {
  await getPool();

  console.log('Adicionando coluna quantidade em EQUIPSTI_opcoes...');
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'EQUIPSTI_opcoes' AND COLUMN_NAME = 'quantidade'
    )
    ALTER TABLE dbo.EQUIPSTI_opcoes ADD quantidade INT NULL DEFAULT 0;
  `);

  console.log('Coluna quantidade adicionada com sucesso.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});

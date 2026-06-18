import dotenv from 'dotenv';
import { getPool, query } from './db.js';

dotenv.config();

async function main() {
  await getPool();

  console.log('Adicionando coluna justificativa em EQUIPSTI_registros_log...');
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'EQUIPSTI_registros_log' AND COLUMN_NAME = 'justificativa'
    )
    ALTER TABLE dbo.EQUIPSTI_registros_log ADD justificativa NVARCHAR(500) NULL;
  `);

  console.log('Coluna justificativa adicionada com sucesso.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});

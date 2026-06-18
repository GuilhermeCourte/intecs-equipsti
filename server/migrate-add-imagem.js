import dotenv from 'dotenv';
import { getPool, query } from './db.js';

dotenv.config();

async function main() {
  await getPool();

  console.log('Adicionando colunas de imagem em EQUIPSTI_registros...');
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'EQUIPSTI_registros' AND COLUMN_NAME = 'imagem_base64'
    )
    ALTER TABLE dbo.EQUIPSTI_registros ADD imagem_base64 NVARCHAR(MAX) NULL;
  `);
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'EQUIPSTI_registros' AND COLUMN_NAME = 'imagem2_base64'
    )
    ALTER TABLE dbo.EQUIPSTI_registros ADD imagem2_base64 NVARCHAR(MAX) NULL;
  `);
  await query(`
    IF NOT EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME = 'EQUIPSTI_registros' AND COLUMN_NAME = 'imagem3_base64'
    )
    ALTER TABLE dbo.EQUIPSTI_registros ADD imagem3_base64 NVARCHAR(MAX) NULL;
  `);

  console.log('Colunas de imagem verificadas/adicionadas com sucesso.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});

import dotenv from 'dotenv';
import { getPool, query } from './db.js';

dotenv.config();

async function main() {
  await getPool();

  console.log('Recriando EQUIPSTI_registros com nova ordem de colunas...');
  await query(`
    IF OBJECT_ID('dbo.EQUIPSTI_registros', 'U') IS NOT NULL
      DROP TABLE dbo.EQUIPSTI_registros;

    CREATE TABLE dbo.EQUIPSTI_registros (
      id               INT IDENTITY(1,1) PRIMARY KEY,
      unidade          NVARCHAR(255) NOT NULL,
      status           NVARCHAR(255) NOT NULL,
      setor            NVARCHAR(255) NULL,
      usuario          NVARCHAR(255) NULL,
      ns               NVARCHAR(255) NOT NULL,
      pat         NVARCHAR(255) NULL,
      equipamento      NVARCHAR(255) NOT NULL,
      protocolo        NVARCHAR(255) NULL,
      data_recebimento DATE NULL,
      valor            DECIMAL(15,2) NULL,
      obs              NVARCHAR(MAX) NULL,
      criado_por       NVARCHAR(255) NULL,
      atualizado_por   NVARCHAR(255) NULL,
      criado_em        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
      atualizado_em    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
    );
  `);

  console.log('Tabela recriada com sucesso.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});

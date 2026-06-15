// ============================================================
//  Cria as tabelas (se não existirem) e o primeiro usuário admin.
//  Rode uma vez:  npm run init-db
// ============================================================
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { getPool, query, sql } from './db.js';

dotenv.config();

const DDL = `
IF OBJECT_ID('dbo.EQUIPSTI_usuarios', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_usuarios (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  email      NVARCHAR(255) NOT NULL UNIQUE,
  senha_hash NVARCHAR(255) NOT NULL,
  ativo      BIT NOT NULL DEFAULT 1,
  criado_em  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Tabela já existente sem a coluna 'ativo' (migração):
IF COL_LENGTH('dbo.EQUIPSTI_usuarios', 'ativo') IS NULL
  ALTER TABLE dbo.EQUIPSTI_usuarios ADD ativo BIT NOT NULL DEFAULT 1;

IF OBJECT_ID('dbo.EQUIPSTI_opcoes', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_opcoes (
  id     INT IDENTITY(1,1) PRIMARY KEY,
  lista  NVARCHAR(20)  NOT NULL,   -- UNIDADE | STATUS | SETOR | EQUIPAMENTO
  valor  NVARCHAR(255) NOT NULL,
  oculto BIT NOT NULL DEFAULT 0,
  CONSTRAINT UQ_EQUIPSTI_opcoes UNIQUE (lista, valor)
);

IF OBJECT_ID('dbo.EQUIPSTI_registros', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_registros (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  unidade      NVARCHAR(255) NOT NULL,
  status       NVARCHAR(255) NOT NULL,
  setor        NVARCHAR(255) NULL,
  usuario      NVARCHAR(255) NULL,
  ns           NVARCHAR(255) NOT NULL,
  pat_antigo   NVARCHAR(255) NULL,
  pat_novo     NVARCHAR(255) NULL,
  equipamento  NVARCHAR(255) NOT NULL,
  obs          NVARCHAR(MAX) NULL,
  criado_em    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
`;

async function main() {
  console.log('Conectando ao SQL Server...');
  await getPool();
  console.log('Criando tabelas (se necessário)...');
  await query(DDL);

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const senha = process.env.ADMIN_PASSWORD || '';

  if (email && senha) {
    const existe = await query('SELECT id FROM dbo.EQUIPSTI_usuarios WHERE email = @email', {
      email: { type: sql.NVarChar, value: email }
    });
    if (existe.recordset.length) {
      console.log(`Admin "${email}" já existe — nada a fazer.`);
    } else {
      const hash = await bcrypt.hash(senha, 10);
      await query(
        'INSERT INTO dbo.EQUIPSTI_usuarios (email, senha_hash) VALUES (@email, @hash)',
        { email: { type: sql.NVarChar, value: email }, hash: { type: sql.NVarChar, value: hash } }
      );
      console.log(`Admin "${email}" criado com sucesso.`);
    }
  } else {
    console.log('ADMIN_EMAIL/ADMIN_PASSWORD não definidos no .env — admin não criado.');
  }

  console.log('Pronto.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro ao inicializar o banco:', err.message);
  process.exit(1);
});

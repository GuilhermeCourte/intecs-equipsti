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
  pat     NVARCHAR(255) NULL,
  equipamento  NVARCHAR(255) NOT NULL,
  obs          NVARCHAR(MAX) NULL,
  criado_em    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Migração: remove a coluna pat_antigo (não é mais usada).
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'pat_antigo') IS NOT NULL
  ALTER TABLE dbo.EQUIPSTI_registros DROP COLUMN pat_antigo;

-- Migração: novos campos de protocolo, recebimento e valor.
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'protocolo') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD protocolo NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'data_recebimento') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD data_recebimento DATE NULL;
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'valor') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD valor DECIMAL(15,2) NULL;

-- Migração: autoria.
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'criado_por') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD criado_por NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'atualizado_por') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD atualizado_por NVARCHAR(255) NULL;

-- Migração: nome técnico do equipamento.
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'equipamento_detalhe') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD equipamento_detalhe NVARCHAR(255) NULL;

-- Migração: detalhe vinculado à opção de equipamento.
IF COL_LENGTH('dbo.EQUIPSTI_opcoes', 'detalhe') IS NULL
  ALTER TABLE dbo.EQUIPSTI_opcoes ADD detalhe NVARCHAR(255) NULL;

-- Migração: preço padrão do equipamento no catálogo.
IF COL_LENGTH('dbo.EQUIPSTI_opcoes', 'preco') IS NULL
  ALTER TABLE dbo.EQUIPSTI_opcoes ADD preco DECIMAL(15,2) NULL;

-- Migração: tipo de aquisição do equipamento (COMPRADO | LOCADO).
IF COL_LENGTH('dbo.EQUIPSTI_opcoes', 'tipo_aquisicao') IS NULL
  ALTER TABLE dbo.EQUIPSTI_opcoes ADD tipo_aquisicao NVARCHAR(20) NULL;

-- Migração: insumo (toner) vinculado ao registro de impressora.
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'insumo') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD insumo NVARCHAR(255) NULL;

-- Migração: tipo de aquisição copiado do equipamento no momento do cadastro.
IF COL_LENGTH('dbo.EQUIPSTI_registros', 'tipo_aquisicao') IS NULL
  ALTER TABLE dbo.EQUIPSTI_registros ADD tipo_aquisicao NVARCHAR(20) NULL;

-- Log de alterações.
IF OBJECT_ID('dbo.EQUIPSTI_registros_log', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_registros_log (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  registro_id   INT NOT NULL,
  acao          NVARCHAR(20) NOT NULL,   -- CRIADO | ATUALIZADO
  campo         NVARCHAR(100) NULL,
  valor_anterior NVARCHAR(MAX) NULL,
  valor_novo    NVARCHAR(MAX) NULL,
  usuario       NVARCHAR(255) NOT NULL,
  data_hora     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF OBJECT_ID('dbo.EQUIPSTI_emprestimos', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_emprestimos (
  id              INT IDENTITY(1,1) PRIMARY KEY,
  pat             NVARCHAR(255) NOT NULL,
  ns              NVARCHAR(255) NULL,
  unidade         NVARCHAR(255) NOT NULL,
  data_emprestimo DATE NULL,
  status          NVARCHAR(20) NOT NULL DEFAULT 'EMPRESTADO',
  data_devolucao  DATE NULL,
  obs             NVARCHAR(MAX) NULL,
  criado_em       DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Controle de Chamados INTECS vs MSA (cruza chamado MSA + controle interno INTECS).
-- STATUS MSA: sincronizado do eurosa (coluna status_msa); quando ausente, o
-- cliente calcula a partir das datas de retirada/entrega.
IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecsmsa', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecsmsa (
  id                    INT IDENTITY(1,1) PRIMARY KEY,
  data_solicitacao      DATE NULL,
  numero_chamado_msa    NVARCHAR(255) NULL,
  problema              NVARCHAR(MAX) NULL,
  unidade               NVARCHAR(255) NULL,
  glpi                  NVARCHAR(50) NULL,
  status_intecs         NVARCHAR(20) NULL,
  patrimonio_msa        NVARCHAR(255) NULL,
  ns                    NVARCHAR(255) NULL,
  ponto_instalacao      NVARCHAR(255) NULL,
  descricao_equip       NVARCHAR(255) NULL,
  data_retirada_equip   DATE NULL,
  data_entrega_equip    DATE NULL,
  patrimonio_bkp_intecs NVARCHAR(255) NULL,
  bkp_unidade           NVARCHAR(255) NULL,
  observacao            NVARCHAR(MAX) NULL,
  status_msa            NVARCHAR(20) NULL,   -- status real do chamado na MSA (sincronizado do eurosa)
  criado_por            NVARCHAR(255) NULL,
  atualizado_por        NVARCHAR(255) NULL,
  criado_em             DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Tabela já existente sem a coluna 'status_msa' (migração):
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecsmsa', 'status_msa') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecsmsa ADD status_msa NVARCHAR(20) NULL;
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

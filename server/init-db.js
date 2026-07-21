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

-- Papel/unidade/setor — usados só pelo módulo Chamados Intecs (permissões).
-- role: BASICO | GESTOR | TECNICO | MASTER.
IF COL_LENGTH('dbo.EQUIPSTI_usuarios', 'role') IS NULL
  ALTER TABLE dbo.EQUIPSTI_usuarios ADD role NVARCHAR(20) NOT NULL DEFAULT 'BASICO';
IF COL_LENGTH('dbo.EQUIPSTI_usuarios', 'unidade') IS NULL
  ALTER TABLE dbo.EQUIPSTI_usuarios ADD unidade NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_usuarios', 'setor') IS NULL
  ALTER TABLE dbo.EQUIPSTI_usuarios ADD setor NVARCHAR(255) NULL;

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

-- Migração: CNPJ da unidade.
IF COL_LENGTH('dbo.EQUIPSTI_opcoes', 'cnpj') IS NULL
  ALTER TABLE dbo.EQUIPSTI_opcoes ADD cnpj NVARCHAR(18) NULL;

-- Migração: endereço da unidade.
IF COL_LENGTH('dbo.EQUIPSTI_opcoes', 'endereco') IS NULL
  ALTER TABLE dbo.EQUIPSTI_opcoes ADD endereco NVARCHAR(255) NULL;

-- Tabela de contratos de internet por unidade.
IF OBJECT_ID('dbo.EQUIPSTI_internet', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_internet (
  id               INT IDENTITY(1,1) PRIMARY KEY,
  unidade          NVARCHAR(255) NOT NULL,
  empresa          NVARCHAR(255) NULL,
  contrato_cnpj    NVARCHAR(18)  NULL,
  ip_internet      NVARCHAR(255) NULL,
  up_down          NVARCHAR(100) NULL,
  valor            DECIMAL(15,2) NULL,
  vencimento_dia   INT           NULL,
  telefone_suporte NVARCHAR(100) NULL,
  linha_acesso     NVARCHAR(255) NULL,
  link_acesso      NVARCHAR(500) NULL,
  email_contas     NVARCHAR(255) NULL,
  observacao       NVARCHAR(MAX) NULL,
  criado_em        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  criado_por       NVARCHAR(255) NULL,
  atualizado_por   NVARCHAR(255) NULL
);

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

-- Credenciais biométricas (WebAuthn/FIDO2) — usadas no celular para login só por biometria.
IF OBJECT_ID('dbo.EQUIPSTI_webauthn', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_webauthn (
  id            INT IDENTITY(1,1) PRIMARY KEY,
  usuario_id    INT NOT NULL,
  credential_id NVARCHAR(512) NOT NULL UNIQUE,   -- base64url
  public_key    NVARCHAR(MAX) NOT NULL,          -- base64url
  counter       BIGINT NOT NULL DEFAULT 0,
  transports    NVARCHAR(255) NULL,
  rotulo        NVARCHAR(255) NULL,              -- ex.: "Celular do Fulano"
  criado_em     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Notificações in-app (sininho). Uma linha por destinatário; o autor da ação
-- nunca recebe. 'lido' controla o contador do sininho.
IF OBJECT_ID('dbo.EQUIPSTI_notificacoes', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_notificacoes (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  usuario_id  INT NOT NULL,            -- destinatário (EQUIPSTI_usuarios.id)
  tipo        NVARCHAR(20) NOT NULL,   -- REGISTRO | EMPRESTIMO | CHAMADO
  acao        NVARCHAR(20) NOT NULL,   -- CRIADO | ATUALIZADO | EXCLUIDO | DEVOLVIDO | TRANSFERIDO
  titulo      NVARCHAR(200) NOT NULL,
  mensagem    NVARCHAR(MAX) NULL,
  link        NVARCHAR(60) NULL,       -- id da aba alvo (tab-registros, tab-emprestimos, tab-chamados)
  ref_id      INT NULL,                -- id da entidade afetada
  ator_email  NVARCHAR(255) NULL,      -- quem executou a ação
  lido        BIT NOT NULL DEFAULT 0,
  criado_em   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EQUIPSTI_notif_dest')
  CREATE INDEX IX_EQUIPSTI_notif_dest
    ON dbo.EQUIPSTI_notificacoes (usuario_id, lido, criado_em DESC);

-- ============================================================
-- Chamados INTECS (módulo interno, independente do MSA/Eurosa)
-- + integração Tactical RMM.
-- ============================================================

-- Cache/índice bruto dos agentes vindos da API do Tactical RMM
-- (usado para detectar a máquina do usuário por IP na abertura do chamado).
IF OBJECT_ID('dbo.EQUIPSTI_tactical_agents', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_tactical_agents (
  id               INT IDENTITY(1,1) PRIMARY KEY,
  tactical_agent_id NVARCHAR(64) NOT NULL UNIQUE,
  hostname         NVARCHAR(255) NULL,
  client_name      NVARCHAR(255) NULL,
  site_name        NVARCHAR(255) NULL,
  status_online    BIT NOT NULL DEFAULT 0,
  last_seen        DATETIME2 NULL,
  criado_em        DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF COL_LENGTH('dbo.EQUIPSTI_tactical_agents', 'public_ip') IS NULL
  ALTER TABLE dbo.EQUIPSTI_tactical_agents ADD public_ip NVARCHAR(64) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_tactical_agents', 'local_ips') IS NULL
  ALTER TABLE dbo.EQUIPSTI_tactical_agents ADD local_ips NVARCHAR(255) NULL;

-- Equipamento (entidade de negócio) — referencia um agente do Tactical RMM,
-- com enriquecimento manual por cima (patrimônio, apelido, etc.).
IF OBJECT_ID('dbo.EQUIPSTI_devices', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_devices (
  id                INT IDENTITY(1,1) PRIMARY KEY,
  tactical_agent_id NVARCHAR(64) NOT NULL UNIQUE,
  nome_amigavel     NVARCHAR(255) NULL,
  patrimonio        NVARCHAR(255) NULL,
  numero_serie      NVARCHAR(255) NULL,
  fabricante        NVARCHAR(255) NULL,
  modelo            NVARCHAR(255) NULL,
  dominio           NVARCHAR(255) NULL,
  grupo             NVARCHAR(255) NULL,
  ativo             BIT NOT NULL DEFAULT 1,
  criado_em         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Removido: vínculo fixo usuário<->equipamento ("Meu Equipamento"). Decisão:
-- usuário não fica atrelado a um hostname; o equipamento é detectado por IP
-- no momento da abertura do chamado (ver rota /api/chamados-intecs/verificar-maquina).
IF OBJECT_ID('dbo.EQUIPSTI_device_users', 'U') IS NOT NULL
  DROP TABLE dbo.EQUIPSTI_device_users;

-- Snapshot do equipamento coletado na abertura do chamado (ou refresh manual).
-- Guardado como JSON por categoria para absorver mudanças no shape da API
-- do Tactical RMM sem precisar de migração de coluna a cada campo novo.
IF OBJECT_ID('dbo.EQUIPSTI_device_snapshots', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_device_snapshots (
  id                    INT IDENTITY(1,1) PRIMARY KEY,
  device_id             INT NOT NULL,
  chamado_id            INT NULL,
  coletado_em           DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  os_info               NVARCHAR(MAX) NULL,
  hardware_info         NVARCHAR(MAX) NULL,
  rede_info             NVARCHAR(MAX) NULL,
  seguranca_info        NVARCHAR(MAX) NULL,
  usuario_logado_info   NVARCHAR(MAX) NULL,
  status_online         BIT NULL,
  cpu_pct               DECIMAL(5,2) NULL,
  ram_pct               DECIMAL(5,2) NULL,
  uptime_seg            BIGINT NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EQUIPSTI_device_snapshots_device')
  CREATE INDEX IX_EQUIPSTI_device_snapshots_device
    ON dbo.EQUIPSTI_device_snapshots (device_id, coletado_em DESC);

-- Histórico de eventos ligados a um equipamento (snapshot tirado, vínculo
-- alterado, erro de sincronização com o Tactical RMM, etc.).
IF OBJECT_ID('dbo.EQUIPSTI_device_logs', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_device_logs (
  id          INT IDENTITY(1,1) PRIMARY KEY,
  device_id   INT NOT NULL,
  chamado_id  INT NULL,
  tipo        NVARCHAR(20) NOT NULL,   -- SNAPSHOT | VINCULO | ERRO_SYNC
  descricao   NVARCHAR(MAX) NULL,
  resultado   NVARCHAR(MAX) NULL,
  usuario_id  INT NULL,
  criado_em   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Chamado interno INTECS (independente do MSA/Eurosa).
IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  titulo         NVARCHAR(255) NOT NULL,
  descricao      NVARCHAR(MAX) NULL,
  categoria      NVARCHAR(100) NULL,
  prioridade     NVARCHAR(20) NOT NULL DEFAULT 'NORMAL',
  status         NVARCHAR(20) NOT NULL DEFAULT 'ABERTO',
  usuario_id     INT NOT NULL,
  device_id      INT NULL,
  snapshot_id    INT NULL,
  criado_por     NVARCHAR(255) NULL,
  atualizado_por NVARCHAR(255) NULL,
  criado_em      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  fechado_em     DATETIME2 NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EQUIPSTI_chamados_intecs_usuario')
  CREATE INDEX IX_EQUIPSTI_chamados_intecs_usuario
    ON dbo.EQUIPSTI_chamados_intecs (usuario_id, criado_em DESC);

-- ============================================================
-- Fase 2: SLA, categorias/subcategorias, comentários, histórico.
-- prioridade passa a ser BAIXA|MEDIA|ALTA|CRITICA (era BAIXA|NORMAL|ALTA|URGENTE);
-- status passa a ser ABERTO|EM_ANALISE|AGUARDANDO_USUARIO|EM_ATENDIMENTO|
-- AGUARDANDO_FORNECEDOR|RESOLVIDO|FECHADO|CANCELADO (era ABERTO|ANDAMENTO|FINALIZADO).
-- Sem dados reais gravados ainda — valores são só de aplicação, não há CHECK
-- constraint no banco, então a mudança de rótulo não exige migração de dados.
-- ============================================================

-- Migração: coluna 'categoria' (texto livre) vira categoria_id/subcategoria_id (FK).
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'categoria') IS NOT NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs DROP COLUMN categoria;

IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'categoria_id') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD categoria_id INT NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'subcategoria_id') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD subcategoria_id INT NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'responsavel_id') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD responsavel_id INT NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'unidade') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD unidade NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'departamento') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD departamento NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'localizacao') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD localizacao NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'telefone') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD telefone NVARCHAR(50) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'ramal') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD ramal NVARCHAR(20) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'email_contato') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD email_contato NVARCHAR(255) NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'sla_resposta_prazo') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD sla_resposta_prazo DATETIME2 NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'sla_conclusao_prazo') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD sla_conclusao_prazo DATETIME2 NULL;
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs', 'sla_respondido_em') IS NULL
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs ADD sla_respondido_em DATETIME2 NULL;

IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_categorias', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs_categorias (
  id    INT IDENTITY(1,1) PRIMARY KEY,
  nome  NVARCHAR(100) NOT NULL UNIQUE,
  ativo BIT NOT NULL DEFAULT 1
);

IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_subcategorias', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs_subcategorias (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  categoria_id INT NOT NULL,
  nome         NVARCHAR(100) NOT NULL,
  ativo        BIT NOT NULL DEFAULT 1,
  CONSTRAINT UQ_EQUIPSTI_ci_subcat UNIQUE (categoria_id, nome)
);

IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_comentarios', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs_comentarios (
  id         INT IDENTITY(1,1) PRIMARY KEY,
  chamado_id INT NOT NULL,
  usuario_id INT NOT NULL,
  texto      NVARCHAR(MAX) NOT NULL,
  criado_em  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EQUIPSTI_ci_comentarios_chamado')
  CREATE INDEX IX_EQUIPSTI_ci_comentarios_chamado
    ON dbo.EQUIPSTI_chamados_intecs_comentarios (chamado_id, criado_em);

IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_historico', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs_historico (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  chamado_id     INT NOT NULL,
  usuario_id     INT NULL,
  acao           NVARCHAR(20) NOT NULL,   -- CRIADO|STATUS|RESPONSAVEL|PRIORIDADE|CATEGORIA|COMENTARIO|EDITADO
  campo          NVARCHAR(100) NULL,
  valor_anterior NVARCHAR(MAX) NULL,
  valor_novo     NVARCHAR(MAX) NULL,
  criado_em      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EQUIPSTI_ci_historico_chamado')
  CREATE INDEX IX_EQUIPSTI_ci_historico_chamado
    ON dbo.EQUIPSTI_chamados_intecs_historico (chamado_id, criado_em);

-- Seed inicial de categorias.
INSERT INTO dbo.EQUIPSTI_chamados_intecs_categorias (nome)
SELECT v FROM (VALUES
  ('Infraestrutura'), ('Rede'), ('Telefonia'), ('Sistema'), ('ERP'),
  ('Impressoras'), ('Equipamentos'), ('Acesso'), ('E-mail'), ('VPN'),
  ('Office'), ('Segurança'), ('Outros')
) AS s(v)
WHERE NOT EXISTS (SELECT 1 FROM dbo.EQUIPSTI_chamados_intecs_categorias c WHERE c.nome = s.v);

-- Seed mínimo de subcategorias (Equipamentos).
INSERT INTO dbo.EQUIPSTI_chamados_intecs_subcategorias (categoria_id, nome)
SELECT c.id, s.v
FROM dbo.EQUIPSTI_chamados_intecs_categorias c
CROSS JOIN (VALUES ('Notebook'), ('Desktop'), ('Monitor')) AS s(v)
WHERE c.nome = 'Equipamentos'
  AND NOT EXISTS (
    SELECT 1 FROM dbo.EQUIPSTI_chamados_intecs_subcategorias sc
    WHERE sc.categoria_id = c.id AND sc.nome = s.v
  );

-- ============================================================
-- Fase 3: papéis/permissões (Básico/Gestor/Técnico/Master) — só do
-- módulo Chamados Intecs.
-- ============================================================

-- Removido: tabela separada de atribuição gestor->unidade/setor. Decisão:
-- o Gestor passa a supervisionar diretamente a unidade/setor do próprio
-- perfil (colunas já existentes em EQUIPSTI_usuarios), sem tabela à parte.
IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_gestores', 'U') IS NOT NULL
  DROP TABLE dbo.EQUIPSTI_chamados_intecs_gestores;

-- ============================================================
-- Fase 5: prioridades e status configuráveis (com SLA por prioridade).
-- As colunas EQUIPSTI_chamados_intecs.status/prioridade continuam texto
-- livre (guardam o 'nome' daqui) — sem FK, sem migração de chamados já
-- criados. "Excluir" é soft delete (ativo = 0).
-- ============================================================
IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_prioridades', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs_prioridades (
  id                  INT IDENTITY(1,1) PRIMARY KEY,
  nome                NVARCHAR(50) NOT NULL UNIQUE,
  sla_resposta_horas  DECIMAL(6,2) NOT NULL,
  sla_conclusao_horas DECIMAL(6,2) NOT NULL,
  cor                 NVARCHAR(20) NULL,
  ordem               INT NOT NULL DEFAULT 0,
  ativo               BIT NOT NULL DEFAULT 1
);

INSERT INTO dbo.EQUIPSTI_chamados_intecs_prioridades (nome, sla_resposta_horas, sla_conclusao_horas, cor, ordem)
SELECT v.nome, v.resposta, v.conclusao, v.cor, v.ordem FROM (VALUES
  ('BAIXA', 24, 72, 'success', 1),
  ('MEDIA', 8, 24, 'warning', 2),
  ('ALTA', 2, 8, 'orange', 3),
  ('CRITICA', 0.5, 2, 'danger', 4)
) AS v(nome, resposta, conclusao, cor, ordem)
WHERE NOT EXISTS (SELECT 1 FROM dbo.EQUIPSTI_chamados_intecs_prioridades p WHERE p.nome = v.nome);

-- tipo_sistema: ABERTO | ANDAMENTO | RESOLVIDO | FECHADO | CANCELADO.
-- Fixa o comportamento automático (SLA vencido, dashboard, fechamento)
-- independente do nome/rótulo customizado do status.
IF OBJECT_ID('dbo.EQUIPSTI_chamados_intecs_status', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_chamados_intecs_status (
  id           INT IDENTITY(1,1) PRIMARY KEY,
  nome         NVARCHAR(50) NOT NULL UNIQUE,
  tipo_sistema NVARCHAR(20) NOT NULL,
  cor          NVARCHAR(20) NULL,
  ordem        INT NOT NULL DEFAULT 0,
  ativo        BIT NOT NULL DEFAULT 1
);

INSERT INTO dbo.EQUIPSTI_chamados_intecs_status (nome, tipo_sistema, cor, ordem)
SELECT v.nome, v.tipo, v.cor, v.ordem FROM (VALUES
  ('ABERTO', 'ABERTO', 'secondary', 1),
  ('EM_ANALISE', 'ANDAMENTO', 'info', 2),
  ('AGUARDANDO_USUARIO', 'ANDAMENTO', 'warning', 3),
  ('EM_ATENDIMENTO', 'ANDAMENTO', 'primary', 4),
  ('AGUARDANDO_FORNECEDOR', 'ANDAMENTO', 'warning', 5),
  ('RESOLVIDO', 'RESOLVIDO', 'success', 6),
  ('FECHADO', 'FECHADO', 'dark', 7),
  ('CANCELADO', 'CANCELADO', 'danger', 8)
) AS v(nome, tipo, cor, ordem)
WHERE NOT EXISTS (SELECT 1 FROM dbo.EQUIPSTI_chamados_intecs_status s WHERE s.nome = v.nome);

-- notifica_solicitante: este status manda e-mail para quem abriu o chamado?
-- Não dá para deduzir de tipo_sistema — AGUARDANDO_USUARIO e EM_ATENDIMENTO são
-- os dois 'ANDAMENTO', mas só o primeiro exige ação do solicitante. Fica como
-- coluna própria para o rótulo continuar customizável sem quebrar o aviso.
IF COL_LENGTH('dbo.EQUIPSTI_chamados_intecs_status', 'notifica_solicitante') IS NULL
BEGIN
  ALTER TABLE dbo.EQUIPSTI_chamados_intecs_status
    ADD notifica_solicitante BIT NOT NULL DEFAULT 0;

  -- Marcação inicial só na criação da coluna: depois disso o valor é do usuário.
  EXEC('UPDATE dbo.EQUIPSTI_chamados_intecs_status SET notifica_solicitante = 1
         WHERE nome IN (''AGUARDANDO_USUARIO'', ''RESOLVIDO'', ''FECHADO'', ''CANCELADO'')');
END

-- ============================================================
-- Calendário: vencimentos de licenças, contratos e afins.
-- 'anual' = evento se repete todo ano no mesmo dia/mês de 'data'.
-- ============================================================
IF OBJECT_ID('dbo.EQUIPSTI_calendario_eventos', 'U') IS NULL
CREATE TABLE dbo.EQUIPSTI_calendario_eventos (
  id             INT IDENTITY(1,1) PRIMARY KEY,
  titulo         NVARCHAR(255) NOT NULL,
  tipo           NVARCHAR(100) NOT NULL,
  data           DATE NOT NULL,
  recorrencia    NVARCHAR(20) NOT NULL DEFAULT 'NENHUMA',
  valor          DECIMAL(15,2) NULL,
  observacao     NVARCHAR(MAX) NOT NULL,
  criado_em      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  atualizado_em  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  criado_por     NVARCHAR(255) NULL,
  atualizado_por NVARCHAR(255) NULL
);

-- Migração (tabela criada antes desta mudança): tipo vira texto livre,
-- observação passa a ser obrigatória. A troca da coluna 'anual' BIT por
-- 'recorrencia' (MENSAL|ANUAL|NENHUMA) é feita à parte, em main() — o SQL
-- Server valida o batch inteiro no parse, e a coluna nova ainda não existe
-- na tabela já criada em execuções anteriores deste script.
IF COL_LENGTH('dbo.EQUIPSTI_calendario_eventos', 'anual') IS NOT NULL
  AND COL_LENGTH('dbo.EQUIPSTI_calendario_eventos', 'recorrencia') IS NULL
  ALTER TABLE dbo.EQUIPSTI_calendario_eventos ADD recorrencia NVARCHAR(20) NOT NULL DEFAULT 'NENHUMA';
ALTER TABLE dbo.EQUIPSTI_calendario_eventos ALTER COLUMN tipo NVARCHAR(100) NOT NULL;
UPDATE dbo.EQUIPSTI_calendario_eventos SET observacao = '' WHERE observacao IS NULL;
ALTER TABLE dbo.EQUIPSTI_calendario_eventos ALTER COLUMN observacao NVARCHAR(MAX) NOT NULL;
`;

async function main() {
  console.log('Conectando ao SQL Server...');
  await getPool();
  console.log('Criando tabelas (se necessário)...');
  await query(DDL);

  const temColunaAnual = await query(
    "SELECT COL_LENGTH('dbo.EQUIPSTI_calendario_eventos', 'anual') AS existe"
  );
  if (temColunaAnual.recordset[0].existe != null) {
    await query("UPDATE dbo.EQUIPSTI_calendario_eventos SET recorrencia = 'ANUAL' WHERE anual = 1");
    await query(`
      DECLARE @cname NVARCHAR(200);
      SELECT @cname = dc.name FROM sys.default_constraints dc
        JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
        WHERE dc.parent_object_id = OBJECT_ID('dbo.EQUIPSTI_calendario_eventos') AND c.name = 'anual';
      IF @cname IS NOT NULL
        EXEC('ALTER TABLE dbo.EQUIPSTI_calendario_eventos DROP CONSTRAINT [' + @cname + ']');
      ALTER TABLE dbo.EQUIPSTI_calendario_eventos DROP COLUMN anual;
    `);
    console.log('Migração: coluna "anual" convertida para "recorrencia" e removida.');
  }

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const senha = process.env.ADMIN_PASSWORD || '';

  if (email && senha) {
    const existe = await query('SELECT id FROM dbo.EQUIPSTI_usuarios WHERE email = @email', {
      email: { type: sql.NVarChar, value: email }
    });
    if (existe.recordset.length) {
      await query("UPDATE dbo.EQUIPSTI_usuarios SET role = 'MASTER' WHERE email = @email",
        { email: { type: sql.NVarChar, value: email } });
      console.log(`Admin "${email}" já existe — papel garantido como MASTER.`);
    } else {
      const hash = await bcrypt.hash(senha, 10);
      await query(
        "INSERT INTO dbo.EQUIPSTI_usuarios (email, senha_hash, role) VALUES (@email, @hash, 'MASTER')",
        { email: { type: sql.NVarChar, value: email }, hash: { type: sql.NVarChar, value: hash } }
      );
      console.log(`Admin "${email}" criado com sucesso (papel MASTER).`);
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

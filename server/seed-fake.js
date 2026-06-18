// ============================================================
//  Dados FICTÍCIOS para teste. Rode:  npm run seed
//  Cria 30 PATs (PAT-001..PAT-030), opções e alguns empréstimos.
//  Reexecutável: limpa antes os dados de teste (prefixo "PAT-").
// ============================================================
import dotenv from 'dotenv';
import { getPool, query, sql } from './db.js';

dotenv.config();

const S = (v) => ({ type: sql.NVarChar, value: v == null ? null : String(v) });

const UNIDADES = ['MATRIZ', 'FILIAL SP', 'FILIAL RJ', 'ALMOXARIFADO', 'CD CAMPINAS'];
const SETORES = ['TI', 'ADMINISTRATIVO', 'FINANCEIRO', 'RH', 'LOGISTICA'];
const EQUIPS = ['DESKTOP', 'MONITOR', 'NOTEBOOK', 'IMPRESSORA', 'SWITCH'];
const STATUS = ['ATIVO', 'INATIVO', 'EM MANUTENCAO'];

async function addOption(lista, valor) {
  await query(`IF NOT EXISTS (SELECT 1 FROM dbo.EQUIPSTI_opcoes WHERE lista=@l AND valor=@v)
    INSERT INTO dbo.EQUIPSTI_opcoes (lista, valor, oculto) VALUES (@l, @v, 0)`,
    { l: S(lista), v: S(valor) });
}

async function emp(pat, unidade, data, status, dataDev, obs) {
  await query(`INSERT INTO dbo.EQUIPSTI_emprestimos (pat, unidade, data_emprestimo, status, data_devolucao, obs)
    VALUES (@pat, @unidade, @data, @status, @dev, @obs)`,
    { pat: S(pat), unidade: S(unidade), data: S(data), status: S(status), dev: S(dataDev), obs: S(obs) });
}

async function main() {
  await getPool();

  console.log('Limpando dados de teste antigos (PAT-*)...');
  await query("DELETE FROM dbo.EQUIPSTI_emprestimos WHERE pat LIKE 'PAT-%'");
  await query("DELETE FROM dbo.EQUIPSTI_registros WHERE pat LIKE 'PAT-%'");

  console.log('Inserindo opções dos dropdowns...');
  for (const u of UNIDADES) await addOption('UNIDADE', u);
  for (const s of SETORES) await addOption('SETOR', s);
  for (const e of EQUIPS) await addOption('EQUIPAMENTO', e);
  for (const st of STATUS) await addOption('STATUS', st);

  console.log('Inserindo 30 registros (PAT-001..PAT-030)...');
  for (let i = 1; i <= 30; i++) {
    const pat = 'PAT-' + String(i).padStart(3, '0');
    await query(`INSERT INTO dbo.EQUIPSTI_registros (unidade, status, setor, usuario, ns, pat, equipamento, obs)
      VALUES (@unidade, @status, @setor, @usuario, @ns, @pat, @equip, @obs)`,
      {
        unidade: S(UNIDADES[i % UNIDADES.length]), status: S(STATUS[i % STATUS.length]),
        setor: S(SETORES[i % SETORES.length]), usuario: S('USUARIO ' + i),
        ns: S('SN' + (1000 + i)), pat: S(pat), equip: S(EQUIPS[i % EQUIPS.length]),
        obs: S('Equipamento de teste ' + i)
      });
  }

  console.log('Inserindo empréstimos (só para alguns PATs)...');
  // PAT-001: histórico com 2 ciclos (devolvido + atualmente emprestado)
  await emp('PAT-001', 'FILIAL SP', '2026-01-10', 'DEVOLVIDO', '2026-02-15', 'Projeto X');
  await emp('PAT-001', 'FILIAL RJ', '2026-04-01', 'EMPRESTADO', null, 'Em uso no evento');
  // PAT-002: atualmente emprestado
  await emp('PAT-002', 'ALMOXARIFADO', '2026-05-20', 'EMPRESTADO', null, '');
  // PAT-003: um ciclo devolvido
  await emp('PAT-003', 'MATRIZ', '2026-03-05', 'DEVOLVIDO', '2026-03-25', 'Manutencao');
  // PAT-005: dois ciclos devolvidos
  await emp('PAT-005', 'FILIAL SP', '2025-11-01', 'DEVOLVIDO', '2025-12-01', '');
  await emp('PAT-005', 'CD CAMPINAS', '2026-02-01', 'DEVOLVIDO', '2026-03-01', '');
  // PAT-008: emprestado em aberto
  await emp('PAT-008', 'FILIAL RJ', '2026-06-01', 'EMPRESTADO', null, 'Substituicao temporaria');
  // PAT-016..030: novos registros extras
  await emp('PAT-016', 'MATRIZ', '2026-01-15', 'EMPRESTADO', null, 'Suporte remoto');
  await emp('PAT-017', 'FILIAL SP', '2026-02-20', 'DEVOLVIDO', '2026-03-10', 'Treinamento');
  await emp('PAT-018', 'CD CAMPINAS', '2026-03-01', 'EMPRESTADO', null, '');
  await emp('PAT-019', 'ALMOXARIFADO', '2025-12-10', 'DEVOLVIDO', '2026-01-05', 'Revisão anual');
  await emp('PAT-020', 'FILIAL RJ', '2026-04-15', 'EMPRESTADO', null, 'Evento externo');
  await emp('PAT-022', 'MATRIZ', '2026-05-01', 'DEVOLVIDO', '2026-05-20', '');
  await emp('PAT-025', 'FILIAL SP', '2026-06-01', 'EMPRESTADO', null, 'Projeto Y');
  await emp('PAT-027', 'CD CAMPINAS', '2026-03-15', 'DEVOLVIDO', '2026-04-10', 'Manutenção');
  // PAT-004, 006, 007, 009..015, 021, 023, 024, 026, 028..030: SEM empréstimo

  console.log('--------------------------------------------------');
  console.log('Concluído! 30 PATs criados.');
  console.log('Com empréstimo: PAT-001 (2 ciclos), 002, 003, 005 (2 ciclos), 008,');
  console.log('  016, 017, 018, 019, 020, 022, 025, 027.');
  console.log('--------------------------------------------------');
  process.exit(0);
}

main().catch((err) => {
  console.error('Erro ao gerar dados de teste:', err.message);
  process.exit(1);
});

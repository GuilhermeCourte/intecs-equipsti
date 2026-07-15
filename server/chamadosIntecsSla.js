// ============================================================
//  SLA dos chamados INTECS — prazos por prioridade (horas), configuráveis
//  via EQUIPSTI_chamados_intecs_prioridades (ver painel "Categorias").
// ============================================================
import { getPrioridadePorNome } from './chamadosIntecsRepository.js';

const FALLBACK = { resposta: 24, conclusao: 72 };

export async function calcularPrazosSla(prioridade, criadoEm = new Date()) {
  let cfg = FALLBACK;
  try {
    const p = await getPrioridadePorNome(prioridade);
    if (p) cfg = { resposta: Number(p.sla_resposta_horas), conclusao: Number(p.sla_conclusao_horas) };
  } catch (err) {
    console.error('[sla] falha ao buscar prioridade, usando fallback:', err.message);
  }
  const base = new Date(criadoEm);
  return {
    sla_resposta_prazo: new Date(base.getTime() + cfg.resposta * 3600000),
    sla_conclusao_prazo: new Date(base.getTime() + cfg.conclusao * 3600000)
  };
}

/**
 * Configuração validada uma vez, no cold start. Um handler que descobre no
 * meio da requisição que faltava uma variável de ambiente já respondeu 500
 * para alguém.
 */
export interface ApiConfig {
  readonly searchEndpoint: string;
  readonly searchIndex: string;
  readonly region: string;
  /** Ecoado no `/health`; é como se confere qual versão está no ar. */
  readonly stage: string;
  /**
   * `max-age` do `Cache-Control` das respostas de busca.
   *
   * Vale para CDN, navegador e para o cache do API Gateway, se ligado. Um
   * minuto é generoso para um catálogo que é atualizado uma vez por dia, e
   * curto o bastante para uma vaga nova não demorar a aparecer.
   */
  readonly cacheSeconds: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export function loadConfig(): ApiConfig {
  return {
    searchEndpoint: required("SEARCH_ENDPOINT"),
    searchIndex: process.env.SEARCH_INDEX ?? "jobs",
    region: process.env.AWS_REGION ?? "us-east-1",
    stage: process.env.STAGE ?? "dev",
    cacheSeconds: Number(process.env.CACHE_SECONDS ?? 60),
  };
}

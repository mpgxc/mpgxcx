/**
 * Configuração validada uma vez, no cold start. Um handler que descobre no
 * meio da execução que faltava uma variável de ambiente já queimou uma
 * mensagem da fila.
 */
export interface AppConfig {
  readonly tableName: string;
  readonly rawBucket: string;
  readonly fetchQueueUrl: string;
  readonly normalizeQueueUrl: string;
  readonly userAgent: string;
  readonly httpTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export function loadConfig(): AppConfig {
  return {
    tableName: required("TABLE_NAME"),
    rawBucket: required("RAW_BUCKET"),
    fetchQueueUrl: required("FETCH_QUEUE_URL"),
    normalizeQueueUrl: required("NORMALIZE_QUEUE_URL"),
    // Identificar o bot é boa prática de scraping — dá à fonte um jeito de
    // pedir para parar em vez de simplesmente bloquear.
    userAgent: process.env.USER_AGENT ?? "job-radar/0.1 (+https://github.com/mpgxc/job-radar)",
    httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 15_000),
  };
}

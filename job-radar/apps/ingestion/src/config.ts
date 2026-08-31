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

/**
 * Configuração do projetor — separada de propósito.
 *
 * O projetor NÃO precisa de bucket raw nem das URLs das filas, e exigi-los só
 * para ele subir seria mentir sobre a dependência. Mas a razão de verdade é
 * outra, e é estrutural: a coleção de busca é criada na `SearchStack`, que
 * depende da `IngestionStack` por causa da tabela. Se as Lambdas de ingestão
 * exigissem `SEARCH_ENDPOINT`, a dependência entre as stacks fecharia um
 * ciclo, e o CloudFormation recusa o deploy inteiro.
 */
export interface ProjectorConfig {
  readonly searchEndpoint: string;
  readonly searchIndex: string;
  readonly region: string;
}

export function loadProjectorConfig(): ProjectorConfig {
  return {
    searchEndpoint: required("SEARCH_ENDPOINT"),
    searchIndex: process.env.SEARCH_INDEX ?? "jobs",
    // O runtime da Lambda sempre define AWS_REGION; o padrão cobre execução local.
    region: process.env.AWS_REGION ?? "us-east-1",
  };
}

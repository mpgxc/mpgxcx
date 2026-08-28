import type { IndexedJob } from "../entities/indexed-job.js";
import type { JobQuery } from "../value-objects/job-query.js";

export interface SearchHit {
  readonly job: IndexedJob;
  /** `null` quando a ordenação não é por relevância — não há score a mostrar. */
  readonly score: number | null;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /**
   * Total de vagas que casam com a consulta.
   *
   * Vem com `isLowerBound` porque índice invertido pára de contar depois de um
   * teto para não varrer a coleção inteira só para exibir um número. Devolver
   * "12.483" quando o índice disse "mais de 1.000" é inventar precisão; a
   * flag deixa a borda escrever "1.000+" com honestidade.
   */
  readonly total: number;
  readonly totalIsLowerBound: boolean;
}

/** O que o `/health` consegue afirmar sobre o índice sem consultar nada. */
export interface SearchIndexStatus {
  readonly index: string;
  readonly documents: number;
}

/**
 * O índice de leitura.
 *
 * Todas as operações de escrita são em LOTE porque quem escreve é o projetor,
 * e ele acorda com um batch inteiro do Stream: uma ida por documento seriam 100
 * requisições HTTP onde uma `_bulk` resolve. O contrato em lote também deixa a
 * assinatura honesta sobre o custo — quem chama enxerga que está pagando uma
 * chamada, não N.
 *
 * Falha de índice NÃO volta como `Result`: OpenSearch fora do ar é o
 * genuinamente excepcional (a mesma régua de `JobRepository`), e o projetor
 * quer exatamente que a exceção suba para o Stream reentregar o batch. `Result`
 * fica para o que é decisão de negócio, como consulta inválida.
 */
export abstract class SearchIndexPort {
  /** Upsert por `IndexedJob.id`. Reprojetar o mesmo documento é inofensivo. */
  abstract index(jobs: readonly IndexedJob[]): Promise<void>;

  /** Remover id ausente é sucesso: o efeito desejado — não estar lá — já vale. */
  abstract remove(jobIds: readonly string[]): Promise<void>;

  abstract search(query: JobQuery): Promise<SearchPage>;

  abstract status(): Promise<SearchIndexStatus>;
}

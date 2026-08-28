import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { SearchHit, SearchIndexPort } from "../domain/ports/search-index.port.js";
import { JobQuery, type JobQueryInput } from "../domain/value-objects/job-query.js";

export interface SearchJobsOutput {
  readonly hits: readonly SearchHit[];
  readonly total: number;
  readonly totalIsLowerBound: boolean;
  /** A consulta como o domínio a entendeu — devolvida para a borda ecoar. */
  readonly query: JobQuery;
  /** `false` na última página. Evita o cliente pedir uma página vazia. */
  readonly hasMore: boolean;
}

/**
 * Busca vagas no índice de leitura.
 *
 * O use-case recebe a entrada CRUA e valida aqui dentro, em vez de exigir um
 * `JobQuery` já pronto. Isso é o que mantém a regra de validação no domínio: se
 * a borda tivesse que construir o value-object, ela precisaria decidir o que
 * fazer com a falha, e a segunda borda (um consumidor de fila, um CLI) decidiria
 * de novo, provavelmente diferente. Aqui a falha é sempre a mesma
 * `BusinessError` do tipo `VALIDATION`, e a borda só a traduz.
 */
export class SearchJobsUseCase {
  constructor(private readonly index: SearchIndexPort) {}

  async execute(input: JobQueryInput): Promise<Result<SearchJobsOutput, BusinessError>> {
    const query = JobQuery.create(input);
    if (query.isErr()) return Result.err(query.error);

    const page = await this.index.search(query.value);

    return Result.ok({
      hits: page.hits,
      total: page.total,
      totalIsLowerBound: page.totalIsLowerBound,
      query: query.value,
      // Com total limitado por teto, "tem mais" se apoia no que veio: página
      // cheia é indício de continuação, página curta é o fim. Comparar contra
      // um total que é limite inferior daria "próxima página" para o vazio.
      hasMore: page.hits.length === query.value.size,
    });
  }
}

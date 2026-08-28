import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

const BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";

export interface AshbyListJobsParams {
  /** Slug do board na URL pública: "ashby", "ramp", "openai", "linear". */
  readonly slug: string;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/**
 * Camada 1 — só transporte. Um método por endpoint, dono do timeout, e nenhum
 * conhecimento de `JobPosting`. Falhas saem como `SourceHttpError`.
 */
export class AshbyClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  async listJobs(params: AshbyListJobsParams): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: AshbyClient.buildUrl(params),
        etag: params.etag ?? null,
        lastModified: params.lastModified ?? null,
      }),
    );
  }

  /**
   * `includeCompensation=true` é obrigatório para o nosso uso e NÃO é default —
   * é a mesma armadilha do `content=true` do Greenhouse, medida da mesma forma:
   * sem o parâmetro, a chave `compensation` não vem vazia, ela simplesmente
   * NÃO EXISTE no item (e `shouldDisplayCompensationOnJobPostings` some junto).
   *
   * Uma regressão que "limpasse" a URL apagaria a faixa salarial de todas as
   * vagas em silêncio, então o parâmetro está coberto por teste e a ausência de
   * `compensation` é acusada pela guarda de contrato.
   *
   * O board não pagina: a resposta é o dump completo. Medido no `openai`, isso
   * dá 755 vagas e 13.033.956 bytes numa única resposta.
   */
  static buildUrl(params: Pick<AshbyListJobsParams, "slug">): string {
    const slug = encodeURIComponent(params.slug.trim());
    return `${BASE_URL}/${slug}?includeCompensation=true`;
  }
}

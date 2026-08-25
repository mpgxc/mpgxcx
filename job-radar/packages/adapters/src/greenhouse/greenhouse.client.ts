import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

const BASE_URL = "https://api.greenhouse.io/v1/boards";

export interface GreenhouseListJobsParams {
  /** Slug do board na URL pública: "stripe", "figma", "vercel". */
  readonly slug: string;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/**
 * Camada 1 — só transporte. Um método por endpoint, dono do timeout, e nenhum
 * conhecimento de `JobPosting`. Falhas saem como `SourceHttpError`.
 */
export class GreenhouseClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  async listJobs(params: GreenhouseListJobsParams): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: GreenhouseClient.buildUrl(params),
        etag: params.etag ?? null,
        lastModified: params.lastModified ?? null,
      }),
    );
  }

  /**
   * Os dois parâmetros de query são obrigatórios para o nosso uso, e nenhum é
   * default da API — ambos medidos contra a resposta real:
   *
   * - sem `content=true`, o item vem SEM a chave `content` (não vazia: ausente);
   * - sem `pay_transparency=true`, o item vem SEM `pay_input_ranges`.
   *
   * O board não pagina: medido no board `greenhouse`, `?page=2` e
   * `?per_page=5` são ignorados e a resposta é sempre o dump completo, com o
   * mesmo primeiro id. É por isso que existe um único método aqui.
   */
  static buildUrl(params: Pick<GreenhouseListJobsParams, "slug">): string {
    const slug = encodeURIComponent(params.slug.trim());
    return `${BASE_URL}/${slug}/jobs?content=true&pay_transparency=true`;
  }
}

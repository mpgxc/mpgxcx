import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

const BASE_URL = "https://employability-portal.gupy.io/api/v1/jobs";

/** O portal recusa `limit` acima disso. */
export const GUPY_MAX_LIMIT = 100;

export interface GupyListJobsParams {
  readonly term: string;
  readonly offset: number;
  readonly limit: number;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/**
 * Camada 1 — só transporte. Um método por endpoint, dono do timeout, e nenhum
 * conhecimento de `JobPosting`. Falhas saem como `SourceHttpError`.
 */
export class GupyClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  async listJobs(params: GupyListJobsParams): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: GupyClient.buildUrl(params),
        etag: params.etag ?? null,
        lastModified: params.lastModified ?? null,
      }),
    );
  }

  /**
   * O parâmetro de busca DEVE ser `jobName` (ou `term`). Usar `name=` devolve
   * HTTP 400 — validado contra a API real, e coberto por teste.
   */
  static buildUrl(params: Pick<GupyListJobsParams, "term" | "offset" | "limit">): string {
    const query = new URLSearchParams({
      jobName: params.term,
      offset: String(params.offset),
      limit: String(Math.min(params.limit, GUPY_MAX_LIMIT)),
    });
    return `${BASE_URL}?${query.toString()}`;
  }
}

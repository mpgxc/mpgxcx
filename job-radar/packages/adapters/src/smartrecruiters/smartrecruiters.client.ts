import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

const BASE_URL = "https://api.smartrecruiters.com/v1/companies";

/**
 * A fonte GRAMPEIA `limit` em 100 — medido: `limit=200` devolve `limit: 100` no
 * envelope e 100 itens. Pedir mais só produziria uma discrepância silenciosa
 * entre o que a trilha acha que pediu e o que veio.
 */
export const SMARTRECRUITERS_PAGE_SIZE = 100;

export interface SmartRecruitersListPostingsParams {
  /** Identificador da empresa na URL: "BoschGroup", "smartrecruiters". */
  readonly slug: string;
  readonly offset: number;
  readonly limit: number;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/**
 * Camada 1 — só transporte. Um método por endpoint, dono do timeout, e nenhum
 * conhecimento de `JobPosting`. Falhas saem como `SourceHttpError`.
 */
export class SmartRecruitersClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  async listPostings(params: SmartRecruitersListPostingsParams): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: SmartRecruitersClient.buildUrl(params),
        etag: params.etag ?? null,
        lastModified: params.lastModified ?? null,
      }),
    );
  }

  /**
   * O identificador da empresa é CASE-SENSITIVE, e isso não é detalhe: medido,
   * `smartrecruiters` devolve as 8 vagas da empresa e `SmartRecruiters` devolve
   * lista vazia com HTTP 200 — sem erro nenhum. Por isso o slug entra na URL
   * exatamente como está no registro de fontes, sem normalizar caixa: "ajustar"
   * a caixa aqui transformaria uma linha correta do registro num board fantasma.
   */
  static buildUrl(
    params: Omit<SmartRecruitersListPostingsParams, "etag" | "lastModified">,
  ): string {
    const slug = encodeURIComponent(params.slug.trim());
    const query = new URLSearchParams({
      limit: String(Math.min(params.limit, SMARTRECRUITERS_PAGE_SIZE)),
      offset: String(params.offset),
    });
    return `${BASE_URL}/${slug}/postings?${query.toString()}`;
  }
}

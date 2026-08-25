import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

const BASE_URL = "https://api.lever.co/v0/postings";

/**
 * Page size da trilha.
 *
 * A fonte NÃO grampeia `limit` — medido no board `palantir`, `limit=500`
 * devolve as 308 vagas de uma vez. O teto aqui é nosso, não dela: cada vaga do
 * Lever carrega a descrição repetida em oito campos (`description`,
 * `descriptionPlain`, `descriptionBody`, `opening`, `additional`...), e 100
 * vagas já dão ~2 MB de corpo. Página menor mantém o objeto do S3 e a
 * invocação de normalização num tamanho previsível.
 */
export const LEVER_PAGE_SIZE = 100;

export interface LeverListPostingsParams {
  /** Slug do board na URL pública: "palantir", "matchgroup", "leverdemo". */
  readonly slug: string;
  readonly skip: number;
  readonly limit: number;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/**
 * Camada 1 — só transporte. Um método por endpoint, dono do timeout, e nenhum
 * conhecimento de `JobPosting`. Falhas saem como `SourceHttpError`.
 */
export class LeverClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  async listPostings(params: LeverListPostingsParams): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: LeverClient.buildUrl(params),
        etag: params.etag ?? null,
        lastModified: params.lastModified ?? null,
      }),
    );
  }

  /**
   * A URL é montada aqui e em lugar nenhum mais porque um parâmetro a mais
   * troca a FORMA da raiz, não o conteúdo.
   *
   * Medido contra a API real: `mode=json` é inócuo — a resposta com e sem ele é
   * byte a byte idêntica, e ele fica só porque é a forma canônica documentada
   * pela fonte. Quem muda tudo é `group`: com `group=team` a raiz deixa de ser
   * o array de vagas e vira `[{title, postings:[...]}]`, ainda com HTTP 200. O
   * parser inteiro assume array de vagas na raiz, então este método nunca
   * repassa parâmetro de agrupamento, e há teste fixando isso.
   */
  static buildUrl(params: Omit<LeverListPostingsParams, "etag" | "lastModified">): string {
    const slug = encodeURIComponent(params.slug.trim());
    const query = new URLSearchParams({
      mode: "json",
      skip: String(params.skip),
      limit: String(Math.min(params.limit, LEVER_PAGE_SIZE)),
    });
    return `${BASE_URL}/${slug}?${query.toString()}`;
  }
}

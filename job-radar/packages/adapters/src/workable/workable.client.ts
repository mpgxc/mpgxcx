import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

const BASE_URL = "https://apply.workable.com/api/v1/widget/accounts";

export interface WorkableListJobsParams {
  /** Slug da conta na URL pública: "blueground", "acme-corp". */
  readonly slug: string;
  readonly etag?: string | null;
  readonly lastModified?: string | null;
}

/**
 * Camada 1 — só transporte. Um método por endpoint, dono do timeout, e nenhum
 * conhecimento de `JobPosting`. Falhas saem como `SourceHttpError`.
 *
 * ATENÇÃO OPERACIONAL — esta é a fonte mais sensível a volume das quatro deste
 * PR. O endpoint fica atrás de Cloudflare com limite por IP agressivo: durante
 * a sondagem, ~10 requisições em poucos minutos bastaram para virar HTTP 429
 * com corpo `error code: 1015` e `retry-after: 22205` (mais de seis horas).
 * Trocar o User-Agent não ajudou — o bloqueio é por IP.
 *
 * O 429 já cai no caminho certo sozinho: `SourceHttpError.isRetryable` é true,
 * o `CircuitBreaker` conta como indisponibilidade e abre o circuito, e o
 * adapter devolve `SourceUnavailable`. O que NÃO pode acontecer é a
 * concorrência da Lambda de fetch subir sem que alguém releia isto: com um
 * `retry-after` de horas, um pico de paralelismo não custa uma rodada, custa o
 * dia inteiro desta fonte.
 */
export class WorkableClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  async listJobs(params: WorkableListJobsParams): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: WorkableClient.buildUrl(params),
        etag: params.etag ?? null,
        lastModified: params.lastModified ?? null,
      }),
    );
  }

  /**
   * `details=true` é obrigatório e NÃO é default — a terceira fonte deste PR
   * com essa armadilha, junto de `content=true` (Greenhouse) e
   * `includeCompensation=true` (Ashby), e aqui ela é a mais cara de todas.
   *
   * Medido na conta `blueground`: SEM o parâmetro, o item não tem a chave
   * `description` — a vaga vem só com título, cidade e tipo de contrato, e o
   * corpo inteiro cai de 146.824 para 17.977 bytes. O que sobra é insuficiente
   * para extrair stack e senioridade, ou seja: o pipeline continuaria rodando,
   * gravando vagas, e entregaria um catálogo mudo. A guarda de contrato exige
   * `description` justamente para transformar esse silêncio em erro.
   *
   * A conta não pagina: a resposta é o dump completo das vagas publicadas.
   */
  static buildUrl(params: Pick<WorkableListJobsParams, "slug">): string {
    const slug = encodeURIComponent(params.slug.trim());
    return `${BASE_URL}/${slug}?details=true`;
  }
}

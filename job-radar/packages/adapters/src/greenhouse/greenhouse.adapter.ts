import {
  type BusinessError,
  type CacheMetadata,
  type FetchOutcome,
  type FetchTask,
  InvalidSourceConfig,
  type JobPosting,
  JobSourcePort,
  type RawBatch,
  Result,
  type SourceConfig,
  SourceContractDrift,
  SourceUnavailable,
} from "@job-radar/core";
import { NOT_MODIFIED, SourceHttpError } from "../http/http-client.js";
import type { GreenhouseClient } from "./greenhouse.client.js";
import { assertJobsResponse } from "./greenhouse.dto.js";
import { GREENHOUSE_SOURCE_ID, toJobPosting } from "./greenhouse.mapper.js";

/** Slug do board na URL pública: letras, números, hífen e underscore. */
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Board inexistente. A API responde 404 com {"status":404,"error":"Job not found"}. */
const NOT_FOUND = 404;

/**
 * Camada 2 — o ACL. Implementa a porta do domínio usando o client, traduz o
 * erro de transporte em `BusinessError` e mantém os DTOs do Greenhouse contidos
 * aqui.
 */
export class GreenhouseAdapter extends JobSourcePort {
  readonly id = GREENHOUSE_SOURCE_ID;

  constructor(private readonly client: GreenhouseClient) {
    super();
  }

  /**
   * O Greenhouse é um board POR EMPRESA e o endpoint devolve o dump completo:
   * uma requisição traz as 575 vagas do Stripe de uma vez. Então `discover`
   * emite UMA tarefa por slug e acabou.
   *
   * É este adapter que prova que a `JobSourcePort` aguenta os dois formatos do
   * mundo real sem mudança no core: o Gupy encadeia páginas devolvendo `next`
   * a cada `fetch`, e aqui `next` é sempre `null` — não existe um
   * `buildNextTask`. O campo `page` da tarefa fica em 0 para sempre, que é o
   * contrato já documentado em `FetchTask`.
   */
  discover(config: SourceConfig, runId: string): Result<FetchTask[], BusinessError> {
    const slug = config.selector.trim();
    if (!slug) {
      return Result.err(
        InvalidSourceConfig.create(this.id, "selector vazio: é obrigatório o slug do board"),
      );
    }

    if (!SLUG_PATTERN.test(slug)) {
      return Result.err(
        InvalidSourceConfig.create(this.id, `slug '${slug}' tem caractere inválido para a URL`),
      );
    }

    return Result.ok([
      { sourceId: this.id, selector: slug, page: 0, runId, params: config.params },
    ]);
  }

  /**
   * Uma resposta = o board inteiro, e o board inteiro pode ser enorme: medido
   * agora, `stripe` devolve 4.387.089 bytes (575 vagas) e `figma`, 1,8 MB. O
   * limite de mensagem do SQS é 256 KB, então o claim-check
   * (`FetchSourceBatchUseCase`) não é enfeite arquitetural aqui — é a única
   * forma de a etapa de normalização receber esse payload: o corpo cru vai
   * para o S3 e a fila carrega só o ponteiro.
   *
   * O ETag também pesa mais nesta fonte que nas paginadas: o board responde
   * 304 para `if-none-match` (verificado), e um 304 economiza os 4 MB inteiros.
   */
  async fetch(task: FetchTask, cache: CacheMetadata): Promise<Result<FetchOutcome, BusinessError>> {
    try {
      const response = await this.client.listJobs({
        slug: task.selector,
        etag: cache.etag,
        lastModified: cache.lastModified,
      });

      if (response.status === NOT_MODIFIED) {
        return Result.ok({ kind: "not-modified", task });
      }

      const batch: RawBatch = {
        task,
        payload: response.body,
        contentType: response.contentType || "application/json",
        fetchedAt: new Date(),
        cache: { etag: response.etag, lastModified: response.lastModified },
        // Dump completo: nunca há continuação. Ver o comentário do `discover`.
        next: null,
      };

      return Result.ok({ kind: "fetched", batch });
    } catch (error) {
      return Result.err(this.translateError(task, error));
    }
  }

  parse(batch: RawBatch): Result<JobPosting[], BusinessError> {
    let payload: unknown;
    try {
      payload = JSON.parse(batch.payload);
    } catch (error) {
      return Result.err(
        SourceContractDrift.create(
          this.id,
          `corpo não é JSON válido: ${error instanceof Error ? error.message : String(error)}`,
          batch.payload.slice(0, 200),
        ),
      );
    }

    try {
      assertJobsResponse(payload);
    } catch (error) {
      return Result.err(
        SourceContractDrift.create(
          this.id,
          error instanceof Error ? error.message : String(error),
          batch.payload.slice(0, 200),
        ),
      );
    }

    // O slug do board não está no payload: ele vem da tarefa, e é o que dá
    // identidade estável à empresa (`company_name` é texto de exibição).
    const boardSlug = batch.task.selector;

    return Result.ok(payload.jobs.map((dto) => toJobPosting(dto, boardSlug, batch.fetchedAt)));
  }

  /** Erro de transporte -> erro de negócio. Único ponto de tradução. */
  private translateError(task: FetchTask, error: unknown): BusinessError {
    if (error instanceof SourceHttpError) {
      if (error.isRetryable) {
        return SourceUnavailable.create(this.id, {
          status: error.status,
          message: error.message,
        });
      }

      /**
       * Slug inexistente devolve 404 com corpo {"status":404,"error":"Job not
       * found"} — sim, "Job", mesmo sendo o board inteiro que não existe.
       *
       * Isso NÃO é deriva de contrato: a API está saudável e respondeu certo, o
       * que está errado é a linha do registro de fontes. Marcar como config
       * inválida manda a tarefa para a DLQ com o alerta certo em vez de acusar
       * o parser de quebrado.
       */
      if (error.status === NOT_FOUND) {
        return InvalidSourceConfig.create(
          this.id,
          `board '${task.selector}' não existe no Greenhouse (HTTP 404: ${error.body ?? ""})`,
        );
      }

      // Demais 4xx: a fonte está viva e recusou. Não adianta retentar.
      return SourceContractDrift.create(
        this.id,
        `resposta ${error.status}: ${error.message}`,
        error.body,
      );
    }

    return SourceUnavailable.create(this.id, {
      status: null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

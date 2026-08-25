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
import type { AshbyClient } from "./ashby.client.js";
import { assertJobBoardResponse } from "./ashby.dto.js";
import { ASHBY_SOURCE_ID, toJobPosting } from "./ashby.mapper.js";

/** Slug do board na URL pública: letras, números, hífen e underscore. */
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Board inexistente. A API responde 404 com corpo `Not Found` em text/plain. */
const NOT_FOUND = 404;

/**
 * Camada 2 — o ACL. Implementa a porta do domínio usando o client, traduz o
 * erro de transporte em `BusinessError` e mantém os DTOs da Ashby contidos aqui.
 */
export class AshbyAdapter extends JobSourcePort {
  readonly id = ASHBY_SOURCE_ID;

  constructor(private readonly client: AshbyClient) {
    super();
  }

  /**
   * A Ashby é um board POR EMPRESA e o endpoint devolve o dump completo, como
   * o Greenhouse: uma requisição traz as 755 vagas da `openai` de uma vez.
   * Então `discover` emite UMA tarefa por slug e acabou.
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
   * agora, `openai` devolve 13.033.956 bytes (755 vagas) e `ramp`, 2,4 MB. O
   * limite de mensagem do SQS é 256 KB, então o claim-check
   * (`FetchSourceBatchUseCase`) é o que torna esta fonte viável — o corpo cru
   * vai para o S3 e a fila carrega só o ponteiro.
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
      assertJobBoardResponse(payload);
    } catch (error) {
      return Result.err(
        SourceContractDrift.create(
          this.id,
          error instanceof Error ? error.message : String(error),
          batch.payload.slice(0, 200),
        ),
      );
    }

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
       * Slug inexistente devolve 404 com corpo `Not Found` em `text/plain` — o
       * corpo NÃO é JSON, ao contrário do Greenhouse e do Lever. Por isso a
       * detecção olha o status, nunca o corpo.
       *
       * Como nas outras duas, isso não é deriva de contrato: a API está
       * saudável e a linha do registro de fontes é que aponta para um slug
       * morto. E é o sinal que permite ao adapter aceitar `{"jobs":[]}` sem
       * alarme — board vazio de verdade existe (`clerk`, `deel`) e é
       * distinguível aqui, diferente do que acontece no SmartRecruiters.
       */
      if (error.status === NOT_FOUND) {
        return InvalidSourceConfig.create(
          this.id,
          `board '${task.selector}' não existe na Ashby (HTTP 404: ${error.body ?? ""})`,
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

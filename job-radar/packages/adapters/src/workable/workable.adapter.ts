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
import type { WorkableClient } from "./workable.client.js";
import { assertAccountResponse } from "./workable.dto.js";
import { toJobPosting, WORKABLE_SOURCE_ID } from "./workable.mapper.js";

/** Slug da conta na URL pública: letras, números, hífen e underscore. */
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Conta inexistente. A API responde 404 com corpo `Not Found` em text/plain. */
const NOT_FOUND = 404;

/**
 * Camada 2 — o ACL. Implementa a porta do domínio usando o client, traduz o
 * erro de transporte em `BusinessError` e mantém os DTOs do Workable contidos
 * aqui.
 */
export class WorkableAdapter extends JobSourcePort {
  readonly id = WORKABLE_SOURCE_ID;

  constructor(private readonly client: WorkableClient) {
    super();
  }

  /**
   * O Workable é um board POR EMPRESA e o widget devolve o dump completo das
   * vagas publicadas. Então `discover` emite UMA tarefa por slug e acabou.
   *
   * Uma tarefa por rodada também é o que mantém a fonte dentro do limite de
   * taxa dela — ver o aviso no `WorkableClient`.
   */
  discover(config: SourceConfig, runId: string): Result<FetchTask[], BusinessError> {
    const slug = config.selector.trim();
    if (!slug) {
      return Result.err(
        InvalidSourceConfig.create(this.id, "selector vazio: é obrigatório o slug da conta"),
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
      assertAccountResponse(payload);
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

    return Result.ok(
      payload.jobs.map((dto) => toJobPosting(dto, boardSlug, payload.name, batch.fetchedAt)),
    );
  }

  /** Erro de transporte -> erro de negócio. Único ponto de tradução. */
  private translateError(task: FetchTask, error: unknown): BusinessError {
    if (error instanceof SourceHttpError) {
      if (error.isRetryable) {
        /**
         * O 429 do Cloudflare (`error code: 1015`) chega aqui e é retentável
         * por definição — mas o `retry-after` medido foi de mais de seis horas,
         * ou seja: a retentativa dentro da rodada NÃO vai passar. O caminho
         * certo é justamente este: a tarefa esgota as entregas, o
         * `fetch.handler` registra a falha na última, e o sweeper vê a rodada
         * incompleta e NÃO expira nada. Vaga velha por um dia; catálogo intacto.
         */
        return SourceUnavailable.create(this.id, {
          status: error.status,
          message: error.message,
        });
      }

      /**
       * Conta inexistente devolve 404 com corpo `Not Found` em `text/plain`.
       *
       * O Workable é o contraste deste PR: ele TEM o sinal que falta ao
       * SmartRecruiters. Aqui "0 vagas com HTTP 200" significa inequivocamente
       * conta real sem vaga publicada — medido em `acme-corp`, que responde
       * `{"name":"Acme Corp","description":null,"jobs":[]}`. Por isso este
       * adapter aceita board vazio sem alarme, e o do SmartRecruiters não pode.
       */
      if (error.status === NOT_FOUND) {
        return InvalidSourceConfig.create(
          this.id,
          `conta '${task.selector}' não existe no Workable (HTTP 404: ${error.body ?? ""})`,
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

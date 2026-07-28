import {
  type BusinessError,
  type CacheMetadata,
  type FetchOutcome,
  type FetchPolicy,
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
import type { GupyClient } from "./gupy.client.js";
import { GUPY_MAX_LIMIT } from "./gupy.client.js";
import { assertJobsResponse } from "./gupy.dto.js";
import { GUPY_SOURCE_ID, toJobPosting } from "./gupy.mapper.js";

const PAGE_SIZE = GUPY_MAX_LIMIT;

/**
 * Trava de segurança: sem `total` confiável, a paginação só para quando uma
 * página vem incompleta. Um teto explícito impede uma trilha infinita caso a
 * fonte passe a devolver sempre páginas cheias.
 */
const MAX_PAGES = 50;

/**
 * Camada 2 — o ACL. Implementa a porta do domínio usando o client, traduz o
 * erro de transporte em `BusinessError` e mantém os DTOs do Gupy contidos aqui.
 */
export class GupyAdapter extends JobSourcePort {
  readonly id = GUPY_SOURCE_ID;

  readonly policy: FetchPolicy = {
    minDelayMs: 500,
    maxAttempts: 3,
    // É uma API JSON pública do próprio portal, não crawling de página.
    respectsRobotsTxt: false,
    requiresAttribution: false,
  };

  constructor(private readonly client: GupyClient) {
    super();
  }

  /**
   * O Gupy é uma API de BUSCA, não um board por empresa: o `selector` é um
   * termo ("backend", "node", "dados"), e cada termo vira uma trilha de
   * paginação própria.
   */
  discover(config: SourceConfig, runId: string): Result<FetchTask[], BusinessError> {
    const term = config.selector.trim();
    if (!term) {
      return Result.err(
        InvalidSourceConfig.create(this.id, "selector vazio: é obrigatório um termo de busca"),
      );
    }

    return Result.ok([
      { sourceId: this.id, selector: term, page: 0, runId, params: config.params },
    ]);
  }

  async fetch(task: FetchTask, cache: CacheMetadata): Promise<Result<FetchOutcome, BusinessError>> {
    try {
      const response = await this.client.listJobs({
        term: task.selector,
        offset: task.page * PAGE_SIZE,
        limit: PAGE_SIZE,
        etag: cache.etag,
        lastModified: cache.lastModified,
      });

      if (response.status === NOT_MODIFIED) {
        return Result.ok({ kind: "not-modified", task });
      }

      const next = this.buildNextTask(task, response.body);

      const batch: RawBatch = {
        task,
        payload: response.body,
        contentType: response.contentType || "application/json",
        fetchedAt: new Date(),
        cache: { etag: response.etag, lastModified: response.lastModified },
        next,
      };

      return Result.ok({ kind: "fetched", batch });
    } catch (error) {
      return Result.err(this.translateError(error));
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

    return Result.ok(payload.data.map((dto) => toJobPosting(dto, batch.fetchedAt)));
  }

  /**
   * Continua enquanto a página vier CHEIA.
   *
   * Deliberadamente NÃO usamos `pagination.total`: ele é inconsistente. Medido
   * contra a API real com o termo "desenvolvedor":
   *
   *   limit=10  -> total=582   (o valor verdadeiro)
   *   limit=50  -> total=100   (grampeado)
   *   limit=100 -> total=100   (grampeado)
   *
   * enquanto os offsets 0/100/200 devolvem 100 itens distintos cada e o offset
   * 500 devolve 82. Ou seja: confiar em `total` com o nosso page size faria a
   * coleta parar na primeira página e perder ~480 vagas EM SILÊNCIO — que é
   * exatamente o tipo de falha que um agregador não percebe até alguém
   * reclamar que faltam vagas.
   *
   * "Página cheia => pode haver mais" custa uma requisição extra no fim de cada
   * trilha e não depende de nenhuma promessa da fonte.
   */
  private buildNextTask(task: FetchTask, body: string): FetchTask | null {
    if (task.page + 1 >= MAX_PAGES) return null;

    try {
      const payload = JSON.parse(body) as { data?: unknown[] };
      if (!Array.isArray(payload.data)) return null;
      if (payload.data.length < PAGE_SIZE) return null;

      return { ...task, page: task.page + 1 };
    } catch {
      // Corpo ilegível não gera continuação — o erro aparece no `parse`, que é
      // onde ele é diagnosticável.
      return null;
    }
  }

  /** Erro de transporte -> erro de negócio. Único ponto de tradução. */
  private translateError(error: unknown): BusinessError {
    if (error instanceof SourceHttpError) {
      if (error.isRetryable) {
        return SourceUnavailable.create(this.id, {
          status: error.status,
          message: error.message,
        });
      }
      // 4xx: a fonte está viva e recusou. Não adianta retentar — mudou o contrato.
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

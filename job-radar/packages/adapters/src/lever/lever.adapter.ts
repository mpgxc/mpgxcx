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
import { LEVER_PAGE_SIZE, type LeverClient } from "./lever.client.js";
import { assertPostingsResponse } from "./lever.dto.js";
import { LEVER_SOURCE_ID, toJobPosting } from "./lever.mapper.js";

/** Slug do board na URL pública: letras, números, hífen e underscore. */
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Board inexistente. A API responde 404 {"ok":false,"error":"Document not found"}. */
const NOT_FOUND = 404;

/**
 * Trava de segurança: a fonte não publica total nem ponteiro de próxima
 * página, então a paginação só para quando uma página vem incompleta. Um teto
 * explícito impede uma trilha infinita caso a fonte passe a devolver sempre
 * páginas cheias. 50 páginas x 100 = 5.000 vagas, muito acima do maior board
 * medido (308, no `palantir`).
 */
const MAX_PAGES = 50;

/**
 * Camada 2 — o ACL. Implementa a porta do domínio usando o client, traduz o
 * erro de transporte em `BusinessError` e mantém os DTOs do Lever contidos aqui.
 */
export class LeverAdapter extends JobSourcePort {
  readonly id = LEVER_SOURCE_ID;

  constructor(private readonly client: LeverClient) {
    super();
  }

  /**
   * O Lever é um board POR EMPRESA e paginado: o `selector` é o slug e cada
   * slug vira uma trilha de `skip`/`limit` própria, que começa na página 0.
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

  async fetch(task: FetchTask, cache: CacheMetadata): Promise<Result<FetchOutcome, BusinessError>> {
    try {
      const response = await this.client.listPostings({
        slug: task.selector,
        skip: task.page * LEVER_PAGE_SIZE,
        limit: LEVER_PAGE_SIZE,
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
        next: this.buildNextTask(task, response.body),
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
      assertPostingsResponse(payload);
    } catch (error) {
      return Result.err(
        SourceContractDrift.create(
          this.id,
          error instanceof Error ? error.message : String(error),
          batch.payload.slice(0, 200),
        ),
      );
    }

    // O nome da empresa não existe no payload — nem como texto de exibição.
    // A identidade vem da tarefa, que carrega o slug do registro de fontes.
    const boardSlug = batch.task.selector;

    return Result.ok(payload.map((dto) => toJobPosting(dto, boardSlug, batch.fetchedAt)));
  }

  /**
   * Continua enquanto a página vier CHEIA — a mesma regra do Gupy, e pelo mesmo
   * motivo: a resposta do Lever é um array puro, sem `total`, sem `meta` e sem
   * ponteiro de continuação, então não há número nenhum em que se apoiar.
   *
   * Medido no board `palantir` (308 vagas): `skip=0/100/200` devolvem 100 itens
   * distintos cada e `skip=300` devolve 8 — a página incompleta é o único
   * sinal de fim que a fonte dá. Custa uma requisição a mais quando o total é
   * múltiplo exato do page size, e não depende de promessa nenhuma da fonte.
   */
  private buildNextTask(task: FetchTask, body: string): FetchTask | null {
    if (task.page + 1 >= MAX_PAGES) return null;

    try {
      const payload = JSON.parse(body) as unknown;
      if (!Array.isArray(payload)) return null;
      if (payload.length < LEVER_PAGE_SIZE) return null;

      return { ...task, page: task.page + 1 };
    } catch {
      // Corpo ilegível não gera continuação — o erro aparece no `parse`, que é
      // onde ele é diagnosticável.
      return null;
    }
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
       * Slug inexistente devolve 404 `{"ok":false,"error":"Document not found"}`
       * — medido com cinco slugs de lixo distintos.
       *
       * Este 404 é o que salva o Lever da armadilha que derruba o
       * SmartRecruiters neste mesmo PR: aqui "0 vagas" com HTTP 200 significa
       * INEQUIVOCAMENTE empresa sem vaga aberta (medido em `lever` e `plaid`,
       * contas reais que respondem `[]`), porque board morto nem chega a
       * responder 200. Por isso o adapter aceita lista vazia sem reclamar — e é
       * por isso que o SmartRecruiters não pode.
       *
       * Como no Greenhouse, isto NÃO é deriva de contrato: a API está saudável
       * e respondeu certo; o que está errado é a linha do registro de fontes.
       */
      if (error.status === NOT_FOUND) {
        return InvalidSourceConfig.create(
          this.id,
          `board '${task.selector}' não existe no Lever (HTTP 404: ${error.body ?? ""})`,
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

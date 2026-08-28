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
import { SMARTRECRUITERS_PAGE_SIZE, type SmartRecruitersClient } from "./smartrecruiters.client.js";
import { assertPostingsResponse } from "./smartrecruiters.dto.js";
import { SMARTRECRUITERS_SOURCE_ID, toJobPosting } from "./smartrecruiters.mapper.js";

/**
 * Identificador da empresa na URL. Case-sensitive de propósito — ver
 * `SmartRecruitersClient.buildUrl`.
 */
const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Trava de segurança da trilha: 50 páginas x 100 = 5.000 vagas, acima do maior
 * board medido (4.800, no `BoschGroup`) mas com fim garantido.
 */
const MAX_PAGES = 50;

/**
 * Válvula de escape para o board legitimamente vazio.
 *
 * `params` é uma coluna do registro de fontes (DynamoDB), então liberar uma
 * empresa que de fato zerou as vagas é editar UMA LINHA — nunca um deploy, que
 * é a promessa que o `SourceConfig` faz. Ver `assertBoardExists`.
 */
export const ALLOW_EMPTY_BOARD_PARAM = "allowEmptyBoard";

/**
 * Camada 2 — o ACL. Implementa a porta do domínio usando o client, traduz o
 * erro de transporte em `BusinessError` e mantém os DTOs do SmartRecruiters
 * contidos aqui.
 */
export class SmartRecruitersAdapter extends JobSourcePort {
  readonly id = SMARTRECRUITERS_SOURCE_ID;

  constructor(private readonly client: SmartRecruitersClient) {
    super();
  }

  /**
   * Board POR EMPRESA e paginado: o `selector` é o identificador da empresa e
   * cada um vira uma trilha de `limit`/`offset` própria, começando na página 0.
   */
  discover(config: SourceConfig, runId: string): Result<FetchTask[], BusinessError> {
    const slug = config.selector.trim();
    if (!slug) {
      return Result.err(
        InvalidSourceConfig.create(
          this.id,
          "selector vazio: é obrigatório o identificador da empresa",
        ),
      );
    }

    if (!SLUG_PATTERN.test(slug)) {
      return Result.err(
        InvalidSourceConfig.create(
          this.id,
          `identificador '${slug}' tem caractere inválido para a URL`,
        ),
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
        offset: task.page * SMARTRECRUITERS_PAGE_SIZE,
        limit: SMARTRECRUITERS_PAGE_SIZE,
        etag: cache.etag,
        lastModified: cache.lastModified,
      });

      if (response.status === NOT_MODIFIED) {
        return Result.ok({ kind: "not-modified", task });
      }

      // A checagem de board fantasma mora AQUI, e o porquê está em
      // `assertBoardExists`. Ela roda antes de montar o `RawBatch` porque um
      // board fantasma não deve nem chegar ao S3.
      const ghost = this.assertBoardExists(task, response.body);
      if (ghost) return Result.err(ghost);

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

    const boardSlug = batch.task.selector;

    return Result.ok(payload.content.map((dto) => toJobPosting(dto, boardSlug, batch.fetchedAt)));
  }

  /**
   * A ARMADILHA CENTRAL DESTA FONTE — leia antes de "simplificar" isto.
   *
   * O SmartRecruiters responde HTTP 200 com `{"totalFound":0,"content":[]}`
   * tanto para empresa real sem vaga aberta quanto para identificador que não
   * existe. E não é "parecido": é IDÊNTICO. Medido agora, `Visa` (empresa real,
   * com página em `careers.smartrecruiters.com/Visa`) e um slug de lixo
   * devolvem os mesmos 52 bytes, com o MESMO ETag
   * (`W/"32-43Q/EKICDDxY23fhngxb6UYn21I"`). As duas fixtures gravadas são
   * comparadas byte a byte no teste justamente para fixar isso.
   *
   * Não há segunda fonte de verdade para consultar: `GET /v1/companies/{slug}`
   * não existe (a rota devolve 404 para QUALQUER slug, inclusive os válidos) e
   * `careers.smartrecruiters.com/{slug}` responde 302 tanto para board real
   * quanto para lixo. A fonte é, na prática, incapaz de distinguir os dois casos.
   *
   * Por que isso é grave e não um detalhe cosmético: uma linha do registro com
   * o slug errado produziria uma rodada SEM FALHA NENHUMA e com zero vagas. A
   * guarda do `SweepExpiredPostingsUseCase` (`failed === 0 && completed > 0`)
   * veria uma rodada íntegra e expiraria o catálogo inteiro daquela empresa —
   * silenciosamente, que é o pior modo de falha de um agregador. Basta errar a
   * CAIXA do identificador para cair nisso: `SmartRecruiters` devolve vazio e
   * `smartrecruiters` devolve as 8 vagas.
   *
   * Sem sinal para distinguir, resta escolher para que lado errar. A assimetria
   * já está decidida no domínio: "não expirar num dia custa vagas velhas
   * visíveis por mais 24 horas; expirar errado custa o catálogo". Então página
   * 0 vazia é tratada como CONFIG INVÁLIDA — erro não retentável, que vira
   * `recordFailure`, que faz o sweeper pular a fonte e não apagar nada. O
   * operador recebe um alerta acionável ("confira o slug") em vez de um
   * apagamento silencioso.
   *
   * O preço é reconhecido, não escondido: empresa que zera as vagas de verdade
   * passa a acusar erro todo dia, e suas vagas antigas nunca expiram. O
   * `params.allowEmptyBoard = "true"` é a saída — o operador confere o slug uma
   * vez, marca a linha, e a partir daí o board vazio volta a ser aceito e
   * varrido normalmente.
   *
   * Por que em `fetch` e não em `parse`, que seria o lugar "natural" de olhar o
   * payload: só a etapa de fetch alimenta o placar da rodada. O
   * `fetch.handler` chama `recordFailure`; o `normalize.handler` não chama.
   * Um erro devolvido pelo `parse` mandaria a mensagem para a DLQ SEM
   * incrementar `failed`, o sweeper continuaria vendo rodada íntegra e o
   * catálogo seria expirado assim mesmo. A guarda tem que estar do lado que o
   * placar enxerga, e este é o motivo de ela não seguir o padrão dos outros
   * três adapters deste PR.
   *
   * Páginas seguintes ficam de fora: com "página cheia => tem próxima", uma
   * página N>0 vazia é só o fim de uma trilha cujo total era múltiplo exato de
   * 100 — comportamento normal, não board fantasma.
   */
  private assertBoardExists(task: FetchTask, body: string): BusinessError | null {
    if (task.page !== 0) return null;
    // Acesso opcional de propósito: uma mensagem que já estava na fila antes
    // deste deploy pode chegar sem `params`.
    if (task.params?.[ALLOW_EMPTY_BOARD_PARAM] === "true") return null;

    let payload: { totalFound?: unknown; content?: unknown };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      // Corpo ilegível é problema do `parse`, que diagnostica com precisão.
      return null;
    }

    const isEmpty = Array.isArray(payload.content)
      ? payload.content.length === 0
      : payload.totalFound === 0;

    if (!isEmpty) return null;

    return InvalidSourceConfig.create(
      this.id,
      `board '${task.selector}' devolveu 0 vagas na primeira página. ` +
        "A API do SmartRecruiters responde exatamente isto (HTTP 200, totalFound 0) " +
        "tanto para identificador inexistente quanto para empresa sem vaga aberta — " +
        "os dois casos são byte a byte iguais, então não dá para distinguir aqui. " +
        "Confira o identificador no registro de fontes (ele é case-sensitive: " +
        `'SmartRecruiters' devolve vazio, 'smartrecruiters' devolve as vagas). ` +
        `Se a empresa realmente zerou as vagas, marque params.${ALLOW_EMPTY_BOARD_PARAM}="true" ` +
        "na linha da fonte. Enquanto isso, nada é expirado — de propósito.",
    );
  }

  /**
   * Continua enquanto a página vier CHEIA — a mesma regra do Gupy e do Lever.
   *
   * Aqui `totalFound` seria utilizável: diferente do `pagination.total` do
   * Gupy, ele é HONESTO (medido no `BoschGroup`: totalFound=4800, offset 4700
   * devolve 100 itens, offset 4800 devolve 0). Mesmo assim a trilha não se
   * apoia nele, por duas razões:
   *
   * - o custo de confiar e estar errado é perder vagas EM SILÊNCIO, que foi
   *   exatamente o que o `total` do Gupy fez; o custo de não confiar é uma
   *   requisição a mais no fim da trilha;
   * - "página cheia => pode haver mais" já é a regra das outras fontes
   *   paginadas, e uma regra só é uma regra a menos para revalidar quando
   *   alguma delas mudar.
   *
   * `totalFound` continua exigido pela guarda de contrato porque é o campo que
   * a detecção de board fantasma lê.
   */
  private buildNextTask(task: FetchTask, body: string): FetchTask | null {
    if (task.page + 1 >= MAX_PAGES) return null;

    try {
      const payload = JSON.parse(body) as { content?: unknown[] };
      if (!Array.isArray(payload.content)) return null;
      if (payload.content.length < SMARTRECRUITERS_PAGE_SIZE) return null;

      return { ...task, page: task.page + 1 };
    } catch {
      return null;
    }
  }

  /**
   * Erro de transporte -> erro de negócio. Único ponto de tradução.
   *
   * Note o que NÃO existe aqui: um ramo para 404 de board inexistente. Nas
   * outras três fontes deste PR ele é o sinal que separa slug morto de board
   * vazio; aqui a fonte nunca o emite para board inexistente — é por isso que
   * `assertBoardExists` precisa existir.
   */
  private translateError(error: unknown): BusinessError {
    if (error instanceof SourceHttpError) {
      if (error.isRetryable) {
        return SourceUnavailable.create(this.id, {
          status: error.status,
          message: error.message,
        });
      }

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

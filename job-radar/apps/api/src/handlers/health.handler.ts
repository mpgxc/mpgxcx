import type { APIGatewayProxyResult, Context } from "aws-lambda";
import { buildContainer } from "../composition.js";
import { json } from "./http.js";

/**
 * `GET /health` — health check que vale alguma coisa.
 *
 * Um `/health` que devolve `{"ok":true}` sem tocar em nada só prova que a
 * Lambda ligou, e a Lambda liga mesmo com a coleção inacessível, a política de
 * acesso errada ou o índice nunca criado — que são justamente as três formas
 * de esta API estar quebrada. Então o check FAZ uma leitura real no índice e
 * conta os documentos.
 *
 * A contagem é a parte útil: índice de pé com zero documento é o sintoma
 * clássico de projetor que nunca rodou (event source do Stream desconectado,
 * ou política de acesso sem permissão de escrita). Sem o número, esse estado é
 * indistinguível de saúde.
 *
 * A latência da leitura entra na resposta porque coleção NextGen escala a
 * ZERO: a primeira requisição depois de um período parado paga o retorno da
 * capacidade, e sem esse número alguém vai abrir um chamado de "API lenta"
 * para um comportamento que é o desenho.
 */
export async function handler(_event: unknown, context: Context): Promise<APIGatewayProxyResult> {
  const container = buildContainer();
  const correlationId = context.awsRequestId;
  const startedAt = Date.now();

  try {
    const status = await container.searchIndex.status();

    return json(
      200,
      {
        status: "ok",
        stage: container.config.stage,
        index: status.index,
        documents: status.documents,
        latencyMs: Date.now() - startedAt,
      },
      { correlationId },
    );
  } catch (thrown) {
    container.logger.child({ correlationId }).error("índice inacessível no health check", {
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });

    // 503 e não 500: o índice pode voltar sozinho, e é o status que diz ao
    // balanceador e ao monitor que a instância está temporariamente fora.
    return json(
      503,
      {
        status: "degraded",
        stage: container.config.stage,
        index: container.config.searchIndex,
        reason: "índice de busca inacessível",
        latencyMs: Date.now() - startedAt,
      },
      { correlationId },
    );
  }
}

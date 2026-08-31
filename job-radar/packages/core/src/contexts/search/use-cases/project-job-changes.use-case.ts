import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import { PostingStatus } from "../../ingestion/domain/entities/job-posting.js";
import type { IndexedJob } from "../domain/entities/indexed-job.js";
import type { SearchIndexPort } from "../domain/ports/search-index.port.js";

/**
 * Uma mudança no catálogo, já traduzida do transporte para o domínio.
 *
 * São só duas formas porque só existem dois fatos: a vaga passou a ter um
 * estado (qual, o documento diz) ou a linha sumiu da tabela. O projetor não
 * precisa saber se veio de INSERT ou de MODIFY — a projeção é idempotente e
 * distinguir os dois só criaria um caminho a mais para testar.
 */
export type JobChange =
  | { readonly kind: "upserted"; readonly job: IndexedJob }
  | { readonly kind: "removed"; readonly jobId: string };

export interface ProjectJobChangesOutput {
  readonly indexed: number;
  readonly removed: number;
}

/**
 * Aplica no índice de busca o que mudou no catálogo.
 *
 * DECISÃO: VAGA EXPIRADA SAI DO ÍNDICE, não fica com flag.
 *
 * As duas opções se defendem, e a escolha muda a API inteira, então vale
 * escrever o porquê.
 *
 * O que decide é onde mora a verdade. O DynamoDB é `RemovalPolicy.RETAIN` e
 * guarda `status=EXPIRED` com `expiredAt`: o histórico existe e ninguém o
 * perde. O índice é descartável e reconstruível a partir dele — logo, o índice
 * não precisa carregar histórico nenhum, precisa ser barato e correto para a
 * pergunta que responde, que é "o que dá para me candidatar agora".
 *
 * Manter a vaga com flag custa em três frentes ao mesmo tempo. Cresce para
 * sempre: expiração é fluxo contínuo, então o índice acumularia meses de vagas
 * mortas e pagaria armazenamento e OCU por elas — exatamente o custo que a
 * coleção NextGen foi escolhida para evitar. Empurra um filtro implícito para
 * TODA consulta, e um filtro que precisa estar em todo lugar é um filtro que
 * um dia vai faltar em algum lugar: a falha silenciosa vira "o agregador
 * mandou o candidato para uma vaga que não existe mais", que é a pior coisa
 * que um agregador de vagas pode fazer. E envenena a relevância: descrições
 * mortas continuam pesando no IDF e nas contagens de faceta.
 *
 * Removendo, o invariante fica estrutural — "está no índice" É "está viva" —
 * em vez de depender de disciplina em cada chamada. O preço, honesto: não dá
 * para pesquisar histórico pela API de busca, e não existe
 * `?incluirExpiradas=true`. Quem quer o histórico consulta o DynamoDB, que é
 * quem o tem. Em troca, `JobQuery` não tem filtro de status nenhum — não é
 * omissão, é consequência.
 *
 * A volta também é coberta: uma vaga que reaparece na fonte volta para ACTIVE e
 * é reindexada por este mesmo caminho, sem tratamento especial.
 */
export class ProjectJobChangesUseCase {
  constructor(private readonly index: SearchIndexPort) {}

  async execute(
    changes: readonly JobChange[],
  ): Promise<Result<ProjectJobChangesOutput, BusinessError>> {
    const toIndex: IndexedJob[] = [];
    const toRemove: string[] = [];

    for (const change of changes) {
      if (change.kind === "removed") {
        toRemove.push(change.jobId);
        continue;
      }

      if (change.job.status === PostingStatus.ACTIVE) {
        toIndex.push(change.job);
      } else {
        toRemove.push(change.job.id);
      }
    }

    // Remover antes de indexar: se o mesmo id aparecer nos dois lados do mesmo
    // batch (expirou e voltou), o estado final tem que ser o último fato, e o
    // último fato é sempre o documento — remoção só chega por expiração ou por
    // sumiço da linha, e nenhum dos dois vem depois de um upsert no batch.
    if (toRemove.length > 0) await this.index.remove(toRemove);
    if (toIndex.length > 0) await this.index.index(toIndex);

    return Result.ok({ indexed: toIndex.length, removed: toRemove.length });
  }
}

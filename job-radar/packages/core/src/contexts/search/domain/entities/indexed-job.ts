import type { PostingStatus } from "../../../ingestion/domain/entities/job-posting.js";
import type { RemoteMode } from "../../../ingestion/domain/value-objects/location.js";
import type { Currency, SalaryPeriod } from "../../../ingestion/domain/value-objects/money.js";
import type { Seniority } from "../../../ingestion/domain/value-objects/seniority.js";

/**
 * Faixa salarial já achatada para o índice.
 *
 * `Compensation`/`Money` continuam sendo o modelo rico da ingestão; aqui a
 * faixa vira dois inteiros e a moeda, porque é assim que um filtro de range
 * funciona num índice invertido. Reconstituir o value-object para depois
 * desmontá-lo no adapter só adicionaria uma volta.
 */
export interface IndexedSalary {
  readonly minCents: number | null;
  readonly maxCents: number | null;
  readonly currency: Currency;
  readonly period: SalaryPeriod;
}

export interface IndexedJobProps {
  /** O mesmo `JobPosting.id` — o documento e a vaga compartilham identidade. */
  readonly id: string;
  /** Carregado no documento para diagnosticar divergência índice × tabela. */
  readonly contentHash: string;
  readonly status: PostingStatus;
  readonly sourceId: string;
  readonly externalId: string;
  readonly url: string;
  readonly companyName: string;
  readonly companySlug: string;
  readonly title: string;
  /** Só o texto plano. O HTML fica no DynamoDB: pesa e não é buscável. */
  readonly description: string;
  readonly locationRaw: string;
  readonly remote: RemoteMode;
  readonly country: string | null;
  readonly city: string | null;
  readonly seniority: Seniority;
  readonly stack: readonly string[];
  readonly employmentType: string | null;
  readonly salary: IndexedSalary | null;
  /** ISO-8601. Datas trafegam como string até o índice — sem fuso implícito. */
  readonly postedAt: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/**
 * A vaga como o índice de busca a vê — o read model.
 *
 * Deliberadamente NÃO é um `JobPosting`. A entidade de ingestão carrega as
 * invariantes da escrita (os três identificadores, a derivação de senioridade e
 * stack, a transição de status) e nada disso vale no lado da leitura: aqui o
 * documento é imutável, já derivado, e existe para ser filtrado e ranqueado.
 * Reaproveitar `JobPosting` obrigaria o projetor a reconstruir `RichText`,
 * `Location` e `Compensation` só para o construtor recalcular hashes que a
 * tabela já tem — trabalho puro, e pior, uma segunda fonte de verdade para o
 * `contentHash`.
 *
 * A ordenação de `stack` é preservada como veio: ela já é determinística na
 * ingestão, e reordenar aqui faria o documento diferir do que gerou o hash.
 */
export class IndexedJob {
  private constructor(readonly props: IndexedJobProps) {}

  static create(props: IndexedJobProps): IndexedJob {
    return new IndexedJob(props);
  }

  get id(): string {
    return this.props.id;
  }

  get contentHash(): string {
    return this.props.contentHash;
  }

  get status(): PostingStatus {
    return this.props.status;
  }
}

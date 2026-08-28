/**
 * DTOs do widget público do Workable, tipados a partir do payload REAL gravado
 * em `fixtures/workable/`. Estes tipos não saem deste diretório — o core nunca
 * vê `shortcode` nem `telecommuting`.
 *
 * Endpoint: GET https://apply.workable.com/api/v1/widget/accounts/{slug}
 *   ?details=true
 *
 * O que a sondagem revelou e vale ler antes de mexer:
 *
 * - SEM `details=true` a chave `description` NÃO EXISTE no item. É a mesma
 *   armadilha do `content=true` do Greenhouse, e aqui apaga a descrição
 *   inteira: o corpo da conta `blueground` cai de 146.824 para 17.977 bytes.
 * - a resposta traz `description` DUAS VEZES em níveis diferentes: no topo é a
 *   descrição da EMPRESA, dentro do item é a da VAGA. Confundir as duas daria
 *   o mesmo texto para todas as vagas do board e um `contentHash` que nunca
 *   muda. O mapper só lê a do item.
 * - `description` do topo vem `null` em conta sem texto institucional (medido
 *   em `acme-corp`), então nada pode assumir que é string.
 * - não há salário em campo nenhum, em nenhum nível.
 *
 * Slug inexistente devolve HTTP 404 com corpo `Not Found` em `text/plain`
 * (medido com slug de lixo e com `workable`/`pipedrive`, que não são contas do
 * widget). O sinal existe — é o contraste direto com o SmartRecruiters.
 */

/** Uma geografia da vaga. `countryCode` é o único ISO-2 pronto do payload. */
export interface WorkableLocationDto {
  readonly country?: string | null;
  readonly countryCode?: string | null;
  readonly city?: string | null;
  readonly region?: string | null;
  readonly hidden?: boolean;
}

export interface WorkableJobDto {
  readonly title: string;
  /** Id público da vaga, alfanumérico: "0FD01ABC66". É ele que vai na URL. */
  readonly shortcode: string;
  /** Código interno do cliente. Vem "" na maior parte da amostra. */
  readonly code?: string | null;
  /** "Full-time", "Part-time", "Contract", "Temporary", "Internship" — ou "". */
  readonly employment_type?: string | null;
  /** Trabalho remoto. É o ÚNICO sinal de modalidade que a fonte publica. */
  readonly telecommuting?: boolean;
  readonly department?: string | null;
  readonly url: string;
  readonly shortlink?: string | null;
  readonly application_url?: string | null;
  /** Data sem hora: "2026-08-18". */
  readonly published_on?: string | null;
  readonly created_at?: string | null;
  /** Nome do país por extenso ("United States"), não ISO. */
  readonly country?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly education?: string | null;
  /** Nível de experiência em texto de exibição ("Associate", "Entry level"). */
  readonly experience?: string | null;
  readonly function?: string | null;
  readonly industry?: string | null;
  readonly locations?: readonly WorkableLocationDto[];
  /** HTML da VAGA. Só existe com `details=true` na URL. */
  readonly description?: string | null;
}

export interface WorkableAccountDto {
  /** Nome de exibição da EMPRESA — o único dos quatro ATS que publica isso. */
  readonly name?: string | null;
  /** Descrição da EMPRESA, não da vaga. Pode vir `null`. */
  readonly description?: string | null;
  readonly jobs: readonly WorkableJobDto[];
}

/**
 * Guarda de contrato. Não é validação de negócio — é a detecção de que a fonte
 * mudou a API. Falhar aqui com mensagem específica é o que transforma "o
 * pipeline degradou em silêncio" em "o parser do Workable quebrou no campo X".
 *
 * `description` do ITEM é exigida porque é o detector de `details=true` ter
 * sumido da URL. A do topo NÃO é exigida: vem `null` legitimamente.
 */
export function assertAccountResponse(value: unknown): asserts value is WorkableAccountDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("resposta não é um objeto");
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.jobs)) {
    throw new Error(`campo 'jobs' ausente ou não é array (recebido: ${typeof candidate.jobs})`);
  }

  for (const [index, job] of (candidate.jobs as unknown[]).entries()) {
    const record = job as Record<string, unknown>;

    if (typeof record?.shortcode !== "string") {
      throw new Error(`jobs[${index}].shortcode não é string (é ele que identifica a vaga)`);
    }
    if (typeof record?.title !== "string") throw new Error(`jobs[${index}].title não é string`);
    if (typeof record?.url !== "string") throw new Error(`jobs[${index}].url não é string`);

    // A ausência de `description` é o sintoma de `details=true` ter sumido da
    // URL — a chave some do item, não vem vazia.
    if (typeof record?.description !== "string") {
      throw new Error(
        `jobs[${index}].description não é string — a URL perdeu 'details=true'? (recebido: ${typeof record?.description})`,
      );
    }
  }
}

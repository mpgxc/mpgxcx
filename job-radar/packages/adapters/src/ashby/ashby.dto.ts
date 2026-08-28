/**
 * DTOs do job board público da Ashby, tipados a partir do payload REAL gravado
 * em `fixtures/ashby/`. Estes tipos não saem deste diretório — o core nunca vê
 * `compensationTierSummary` nem `secondaryLocations`.
 *
 * Endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{slug}
 *   ?includeCompensation=true
 *
 * Três coisas medidas contra a API real que valem a leitura antes de mexer:
 *
 * - SEM `includeCompensation=true` a chave `compensation` NÃO EXISTE no item
 *   (mesma armadilha do `content=true` do Greenhouse).
 * - a faixa salarial NÃO é um par min/max simples: é uma árvore
 *   `compensationTiers[] -> components[]` que mistura salário, bônus,
 *   comissão e equity. Ver `buildCompensation` no mapper.
 * - o período É declarado (`interval`), diferente do Greenhouse, onde ele
 *   precisa ser deduzido pela magnitude do valor.
 *
 * Slug inexistente devolve HTTP 404 com corpo `Not Found` em `text/plain` —
 * não é JSON. Como o Greenhouse e o Workable, a fonte dá o sinal que separa
 * "board morto no registro" de "empresa sem vaga aberta" (que responde 200 com
 * `{"jobs":[],"apiVersion":"1"}`, medido em `clerk` e `deel`).
 */

export interface AshbyPostalAddressDto {
  readonly addressRegion?: string | null;
  readonly addressCountry?: string | null;
  readonly addressLocality?: string | null;
  readonly postalCode?: string | null;
}

export interface AshbyAddressDto {
  readonly postalAddress?: AshbyPostalAddressDto | null;
}

/**
 * Uma geografia ADICIONAL da mesma vaga — não outra vaga.
 *
 * `country` aqui é NOME por extenso ("Germany", "European Union"), nunca ISO.
 */
export interface AshbySecondaryLocationDto {
  readonly location: string;
  readonly address?: AshbyAddressDto | null;
}

/**
 * Um componente da remuneração.
 *
 * `compensationType` é o campo que importa: o mesmo array traz `Salary`,
 * `Bonus`, `Commission`, `EquityPercentage` e `EquityCashValue`. Somar tudo
 * daria um número que não é salário.
 *
 * `minValue`/`maxValue` vêm em unidade DECIMAL e podem ser FRACIONÁRIOS —
 * `60.58` por hora aparece no board da `openai`. Não são centavos.
 */
export interface AshbyCompensationComponentDto {
  readonly id: string;
  readonly summary?: string | null;
  /** "Salary" | "Bonus" | "Commission" | "EquityPercentage" | "EquityCashValue" */
  readonly compensationType: string;
  /** "1 YEAR" | "1 MONTH" | "1 HOUR" | "NONE" — declarado, não deduzido. */
  readonly interval: string;
  /** ISO 4217, ou `null` quando o componente é equity em porcentagem. */
  readonly currencyCode?: string | null;
  readonly minValue?: number | null;
  readonly maxValue?: number | null;
}

/**
 * Uma faixa por zona/perfil ("EU", "Tier 1"). Uma vaga publica várias — medido
 * até 6 componentes de salário em moedas diferentes na mesma vaga.
 */
export interface AshbyCompensationTierDto {
  readonly id: string;
  readonly tierSummary?: string | null;
  readonly title?: string | null;
  readonly additionalInformation?: string | null;
  readonly components?: readonly AshbyCompensationComponentDto[];
}

export interface AshbyCompensationDto {
  readonly compensationTierSummary?: string | null;
  readonly scrapeableCompensationSalarySummary?: string | null;
  readonly compensationTiers?: readonly AshbyCompensationTierDto[];
  readonly summaryComponents?: readonly AshbyCompensationComponentDto[];
}

export interface AshbyJobDto {
  /** UUID em string. */
  readonly id: string;
  readonly title: string;
  readonly department?: string | null;
  readonly team?: string | null;
  /** "FullTime" | "Contract" | "Temporary" | "Intern" — enum da fonte. */
  readonly employmentType?: string | null;
  /** Texto livre da geografia principal: "Remote - US", "New York, NY (HQ)". */
  readonly location: string;
  readonly secondaryLocations?: readonly AshbySecondaryLocationDto[];
  readonly publishedAt?: string | null;
  /** `true` em 100% das 1.222 vagas medidas em seis boards. */
  readonly isListed?: boolean;
  readonly isRemote?: boolean;
  /** "Remote" | "Hybrid" | "OnSite" | "" — mais específico que `isRemote`. */
  readonly workplaceType?: string | null;
  readonly address?: AshbyAddressDto | null;
  readonly jobUrl: string;
  readonly applyUrl?: string | null;
  /** HTML de verdade, já desescapado — diferente do Greenhouse. */
  readonly descriptionHtml: string;
  readonly descriptionPlain?: string | null;
  readonly shouldDisplayCompensationOnJobPostings?: boolean;
  /** Só existe com `includeCompensation=true` na URL. */
  readonly compensation?: AshbyCompensationDto | null;
}

export interface AshbyJobBoardResponseDto {
  readonly jobs: readonly AshbyJobDto[];
  /** "1" na amostra inteira. Serve de canário se a fonte versionar a API. */
  readonly apiVersion?: string;
}

/**
 * Guarda de contrato. Não é validação de negócio — é a detecção de que a fonte
 * mudou a API. Falhar aqui com mensagem específica é o que transforma "o
 * pipeline degradou em silêncio" em "o parser da Ashby quebrou no campo X".
 *
 * Só é exigido o que o mapper realmente consome. `compensation` é exigido não
 * pelo valor, mas por ser o detector da URL ter perdido
 * `includeCompensation=true` — sem ele o pipeline continuaria "funcionando",
 * calado, sem salário nenhum.
 */
export function assertJobBoardResponse(value: unknown): asserts value is AshbyJobBoardResponseDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("resposta não é um objeto");
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.jobs)) {
    throw new Error(`campo 'jobs' ausente ou não é array (recebido: ${typeof candidate.jobs})`);
  }

  for (const [index, job] of (candidate.jobs as unknown[]).entries()) {
    const record = job as Record<string, unknown>;

    if (typeof record?.id !== "string") throw new Error(`jobs[${index}].id não é string`);
    if (typeof record?.title !== "string") throw new Error(`jobs[${index}].title não é string`);
    if (typeof record?.jobUrl !== "string") throw new Error(`jobs[${index}].jobUrl não é string`);
    if (typeof record?.location !== "string") {
      throw new Error(`jobs[${index}].location não é string`);
    }
    if (typeof record?.descriptionHtml !== "string") {
      throw new Error(`jobs[${index}].descriptionHtml não é string`);
    }
    // A ausência de `compensation` é o sintoma de `includeCompensation=true`
    // ter sumido da URL — a chave some do item inteiro, não vem vazia.
    if (record?.compensation === undefined) {
      throw new Error(
        `jobs[${index}].compensation ausente — a URL perdeu 'includeCompensation=true'?`,
      );
    }
    if (record.secondaryLocations !== undefined && !Array.isArray(record.secondaryLocations)) {
      throw new Error(`jobs[${index}].secondaryLocations presente mas não é array`);
    }
  }
}

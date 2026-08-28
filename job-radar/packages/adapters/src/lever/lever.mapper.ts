import {
  Compensation,
  JobPosting,
  type JobPostingProps,
  Location,
  Money,
  RemoteMode,
  RichText,
  type SalaryPeriod,
} from "@job-radar/core";
import type { LeverPostingDto, LeverSalaryRangeDto } from "./lever.dto.js";

export const LEVER_SOURCE_ID = "lever";

/** `workplaceType` é enum da fonte — mapeia direto, sem adivinhar pelo texto. */
const REMOTE_BY_WORKPLACE_TYPE: Readonly<Record<string, RemoteMode>> = {
  remote: RemoteMode.REMOTE,
  hybrid: RemoteMode.HYBRID,
  onsite: RemoteMode.ONSITE,
  "on-site": RemoteMode.ONSITE,
};

/** `categories.commitment` é texto de exibição do board, não enum estável. */
const EMPLOYMENT_TYPE_BY_COMMITMENT: Readonly<Record<string, string>> = {
  "full-time": "FULL_TIME",
  fulltime: "FULL_TIME",
  "part-time": "PART_TIME",
  parttime: "PART_TIME",
  contract: "CONTRACT",
  contractor: "CONTRACT",
  temporary: "TEMPORARY",
  intern: "INTERNSHIP",
  internship: "INTERNSHIP",
  apprenticeship: "APPRENTICE",
  "fixed term": "FIXED_TERM",
  "fixed-term": "FIXED_TERM",
  scholarship: "SCHOLARSHIP",
  seasonal: "SEASONAL",
};

/**
 * Períodos que o Lever publica e que `SalaryPeriod` sabe representar.
 *
 * A fonte também documenta `per-day-wage`, `per-week-salary` e `one-time`, que
 * o domínio NÃO modela. Faixa nesses períodos vira ausência de faixa em vez de
 * ser convertida na marra: transformar um valor semanal em anual exigiria
 * assumir jornada e número de semanas, e uma faixa inventada é pior que
 * nenhuma — é a mesma regra que o Gupy aplica ao não ter salário.
 */
const PERIOD_BY_INTERVAL: Readonly<Record<string, SalaryPeriod>> = {
  "per-hour-wage": "HOUR",
  "per-month-salary": "MONTH",
  "per-year-salary": "YEAR",
};

/**
 * Camada 2 — o Anti-Corruption Layer propriamente dito.
 *
 * Nada de `LeverPostingDto` atravessa esta função: o que sai é `JobPosting`,
 * que o resto do sistema entende sem saber que o Lever existe.
 *
 * O `boardSlug` entra por parâmetro porque a resposta NÃO carrega o nome da
 * empresa em campo nenhum — nem de exibição. Diferente do Greenhouse, aqui o
 * slug do board é a única identidade de empresa que existe no payload.
 */
export function toJobPosting(dto: LeverPostingDto, boardSlug: string, seenAt: Date): JobPosting {
  const props: JobPostingProps = {
    source: {
      id: LEVER_SOURCE_ID,
      externalId: dto.id,
      url: dto.hostedUrl,
    },
    company: {
      name: boardSlug,
      slug: boardSlug,
    },
    // O título é `text`, não `title` — e vem com espaço sobrando em parte da amostra.
    title: dto.text.trim(),
    description: RichText.fromHtml(buildDescriptionHtml(dto)),
    location: buildLocation(dto),
    compensation: buildCompensation(dto.salaryRange),
    employmentType: normalizeCommitment(dto.categories?.commitment),
    // `createdAt` é epoch em MILISSEGUNDOS. Passar isso para `new Date(string)`
    // daria Invalid Date em silêncio, então a conversão é explícita.
    postedAt: fromEpochMillis(dto.createdAt),
    seenAt,
  };

  return JobPosting.create(props);
}

/**
 * A descrição do Lever vem em SEÇÕES, não num campo único: `description` é a
 * abertura, `lists[]` são os blocos em tópicos ("Key Responsibilities",
 * "Qualifications") e `additional` é o fechamento.
 *
 * Concatenar na ordem publicada é seguro porque as seções são DISJUNTAS —
 * medido nas 159 vagas sondadas de `matchgroup` e `palantir`: nenhum
 * `lists[].content` (480 seções) e nenhum `additional` (159) aparece dentro de
 * `description`. Sem essa medição a concatenação duplicaria texto e envenenaria
 * o `contentHash` e a extração de stack.
 *
 * O título de cada seção entra como `<h3>` porque `content` traz só os `<li>`
 * soltos, sem a `<ul>` em volta: sem o cabeçalho, "Requisitos" e
 * "Responsabilidades" viram uma lista única e indistinguível no texto plano.
 *
 * `descriptionPlain` existe e seria mais barato, mas guardar o HTML é o que
 * permite reprocessar e renderizar depois — o `RichText` deriva o texto plano
 * sozinho.
 */
export function buildDescriptionHtml(dto: LeverPostingDto): string {
  const sections: string[] = [];

  if (dto.description) sections.push(dto.description);

  for (const list of dto.lists ?? []) {
    const title = list.text?.trim();
    if (title) sections.push(`<h3>${title}</h3>`);
    if (list.content) sections.push(`<ul>${list.content}</ul>`);
  }

  if (dto.additional) sections.push(dto.additional);

  return sections.join("\n");
}

/**
 * `country` já vem em ISO 3166-1 alfa-2 ("US", "KR", "JP") — é o único dos
 * quatro ATS deste PR que entrega o código pronto, então nada de heurística de
 * texto aqui. A string vazia (aparece em `matchgroup`) é ausência, não país.
 */
function buildLocation(dto: LeverPostingDto): Location {
  const raw = dto.categories?.location?.trim() || dto.categories?.allLocations?.[0] || "";
  const workplace = dto.workplaceType?.trim().toLowerCase() ?? "";
  const remote = REMOTE_BY_WORKPLACE_TYPE[workplace] ?? RemoteMode.UNKNOWN;
  const country = dto.country?.trim().toUpperCase();

  return Location.fromRaw(raw, {
    remote,
    ...(country ? { country } : {}),
  });
}

/**
 * Faixa salarial em unidade DECIMAL (150000 = US$ 150 mil), diferente do
 * Greenhouse, que publica centavos. `Money.fromDecimal` faz a conversão e
 * devolve `null` para moeda sem suporte — AUD aparece na amostra e não está em
 * `Currency`, então essas vagas ficam sem faixa em vez de derrubar o board.
 */
function buildCompensation(range: LeverSalaryRangeDto | null | undefined): Compensation | null {
  if (!range) return null;

  const period = PERIOD_BY_INTERVAL[range.interval?.trim().toLowerCase() ?? ""];
  if (!period) return null;

  const currency = range.currency?.trim() ?? "";
  const min = typeof range.min === "number" ? Money.fromDecimal(range.min, currency) : null;
  const max = typeof range.max === "number" ? Money.fromDecimal(range.max, currency) : null;

  return Compensation.create({ min, max, period });
}

function normalizeCommitment(commitment: string | null | undefined): string | null {
  const key = commitment?.trim().toLowerCase();
  if (!key) return null;
  return EMPLOYMENT_TYPE_BY_COMMITMENT[key] ?? null;
}

function fromEpochMillis(value: number | null | undefined): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

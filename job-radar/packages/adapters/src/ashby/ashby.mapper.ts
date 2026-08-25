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
import type {
  AshbyCompensationComponentDto,
  AshbyCompensationDto,
  AshbyJobDto,
} from "./ashby.dto.js";

export const ASHBY_SOURCE_ID = "ashby";

/** `workplaceType` é enum da fonte — mapeia direto, sem adivinhar pelo texto. */
const REMOTE_BY_WORKPLACE_TYPE: Readonly<Record<string, RemoteMode>> = {
  remote: RemoteMode.REMOTE,
  hybrid: RemoteMode.HYBRID,
  onsite: RemoteMode.ONSITE,
};

const EMPLOYMENT_TYPE_BY_ASHBY: Readonly<Record<string, string>> = {
  fulltime: "FULL_TIME",
  parttime: "PART_TIME",
  contract: "CONTRACT",
  temporary: "TEMPORARY",
  intern: "INTERNSHIP",
};

/**
 * `interval` é DECLARADO pela fonte, então aqui não há dedução por magnitude
 * como no Greenhouse. "NONE" é o que a Ashby usa para equity, que nunca chega
 * a esta tabela porque só componente `Salary` passa pelo filtro.
 */
const PERIOD_BY_INTERVAL: Readonly<Record<string, SalaryPeriod>> = {
  "1 hour": "HOUR",
  "1 month": "MONTH",
  "1 year": "YEAR",
};

/** O único tipo de componente que é salário. Ver `buildCompensation`. */
const SALARY_COMPONENT = "salary";

/**
 * Camada 2 — o Anti-Corruption Layer propriamente dito.
 *
 * Nada de `AshbyJobDto` atravessa esta função: o que sai é `JobPosting`, que o
 * resto do sistema entende sem saber que a Ashby existe.
 *
 * O `boardSlug` entra por parâmetro porque a resposta não traz nome de empresa
 * em campo nenhum — só o slug, embutido dentro de `jobUrl`. Ler a URL para
 * extrair a identidade seria mais frágil do que usar o valor que o registro de
 * fontes já tem na mão.
 */
export function toJobPosting(dto: AshbyJobDto, boardSlug: string, seenAt: Date): JobPosting {
  const props: JobPostingProps = {
    source: {
      id: ASHBY_SOURCE_ID,
      externalId: dto.id,
      url: dto.jobUrl,
    },
    company: {
      name: boardSlug,
      slug: boardSlug,
    },
    // Há títulos com espaço à esquerda no board da `ramp` (" Security Engineer, Cloud").
    title: dto.title.trim(),
    // Diferente do Greenhouse, a Ashby entrega HTML já desescapado — não há
    // tabela de entidades para desfazer aqui.
    description: RichText.fromHtml(dto.descriptionHtml ?? ""),
    location: buildLocation(dto),
    compensation: buildCompensation(dto.compensation),
    employmentType:
      EMPLOYMENT_TYPE_BY_ASHBY[dto.employmentType?.trim().toLowerCase() ?? ""] ?? null,
    postedAt: parseDate(dto.publishedAt),
    seenAt,
  };

  return JobPosting.create(props);
}

/**
 * Só a geografia PRINCIPAL vira `Location`, e `secondaryLocations` é descartado
 * de propósito.
 *
 * `Location` modela UM lugar; as secundárias são outras geografias da MESMA
 * requisição (51 das 60 vagas do board da própria Ashby têm pelo menos uma, e
 * uma delas tem 19). As duas saídas óbvias são piores:
 *
 * - emitir uma `JobPosting` por geografia quebraria a identidade, que é
 *   (fonte, idExterno): as cópias colidiriam no mesmo `id` e uma sobrescreveria
 *   a outra a cada rodada;
 * - concatenar tudo em `raw` envenenaria a inferência de país, que lê a string
 *   inteira. Medido: "Remote - European Union" + as 19 secundárias faz
 *   `Location` cravar PT (por causa de "Portugal" na lista) numa vaga aberta
 *   para a UE toda. Trocar "sem país" por "país errado" é o pior dos negócios,
 *   porque o filtro de busca passa a esconder a vaga de quem deveria vê-la.
 *
 * A perda é real e está registrada: uma busca por "Espanha" não acha esta vaga.
 * Resolver isso direito é dar ao domínio um `Location[]`, o que é mudança de
 * core — fora do escopo deste PR e anotada como tal.
 *
 * `workplaceType` tem precedência sobre `isRemote` por ser mais específico: no
 * board da `ramp`, "Software Engineer Internship, Android" é `Hybrid` com
 * `isRemote: true`, e híbrido é a informação útil. `isRemote` só desempata
 * quando `workplaceType` vem vazio, o que acontece em 46 das 132 vagas do
 * board da `notion`.
 */
function buildLocation(dto: AshbyJobDto): Location {
  const workplace = dto.workplaceType?.trim().toLowerCase() ?? "";
  const remote =
    REMOTE_BY_WORKPLACE_TYPE[workplace] ??
    (dto.isRemote === true ? RemoteMode.REMOTE : RemoteMode.UNKNOWN);

  return Location.fromRaw(dto.location ?? "", { remote });
}

/**
 * Extrai a faixa salarial de uma árvore que NÃO é uma faixa salarial.
 *
 * `compensationTiers[].components[]` é uma lista heterogênea: no mesmo array
 * convivem `Salary`, `Bonus`, `Commission`, `EquityPercentage` e
 * `EquityCashValue`. Consolidar sem filtrar por `compensationType` produziria
 * um número que não é salário nenhum — somaria bônus e equity à base.
 *
 * Depois do filtro, a consolidação é a mesma do Greenhouse e pelo mesmo motivo:
 * uma vaga publica uma faixa por zona geográfica (até 6 componentes de salário
 * em 3 moedas, medido no board da própria Ashby). Só entram no min/max os
 * componentes que compartilham moeda E período com o primeiro utilizável;
 * misturar EUR anual com GBP anual daria faixa mentirosa.
 */
function buildCompensation(
  compensation: AshbyCompensationDto | null | undefined,
): Compensation | null {
  const components = (compensation?.compensationTiers ?? []).flatMap(
    (tier) => tier.components ?? [],
  );

  const usable = components.filter(isUsableSalaryComponent);
  const [reference] = usable;
  if (!reference) return null;

  const currency = reference.currencyCode?.trim().toUpperCase() ?? "";
  const period = PERIOD_BY_INTERVAL[reference.interval.trim().toLowerCase()];
  if (!period) return null;

  const comparable = usable.filter(
    (component) =>
      component.currencyCode?.trim().toUpperCase() === currency &&
      component.interval.trim().toLowerCase() === reference.interval.trim().toLowerCase(),
  );

  const minValue = Math.min(...comparable.map((component) => component.minValue ?? Number.NaN));
  const maxValue = Math.max(...comparable.map((component) => component.maxValue ?? Number.NaN));

  return Compensation.create({
    min: Money.fromDecimal(minValue, currency),
    max: Money.fromDecimal(maxValue, currency),
    period,
  });
}

/**
 * Componente aproveitável: é salário, tem período que o domínio modela, tem
 * moeda com suporte em `Money` e tem os dois lados da faixa.
 *
 * Moeda sem suporte vira ausência, não erro: SGD, PHP, JPY, KRW, NZD e AUD
 * aparecem na amostra e nenhuma está em `Currency`. Derrubar o board inteiro
 * por causa de uma faixa em iene seria trocar 754 vagas por uma.
 *
 * O valor pode ser FRACIONÁRIO (US$ 60,58 por hora no board da `openai`), então
 * a checagem é de número finito, nunca de inteiro.
 */
function isUsableSalaryComponent(component: AshbyCompensationComponentDto): boolean {
  if (component.compensationType?.trim().toLowerCase() !== SALARY_COMPONENT) return false;
  if (!PERIOD_BY_INTERVAL[component.interval?.trim().toLowerCase() ?? ""]) return false;

  const currency = component.currencyCode?.trim().toUpperCase();
  if (!currency || !Money.isCurrency(currency)) return false;

  const { minValue, maxValue } = component;
  if (typeof minValue !== "number" || typeof maxValue !== "number") return false;
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return false;

  return minValue >= 0 && maxValue >= minValue;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

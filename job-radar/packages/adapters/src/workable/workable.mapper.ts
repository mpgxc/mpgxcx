import { JobPosting, type JobPostingProps, Location, RemoteMode, RichText } from "@job-radar/core";
import type { WorkableJobDto } from "./workable.dto.js";

export const WORKABLE_SOURCE_ID = "workable";

const EMPLOYMENT_TYPE_BY_WORKABLE: Readonly<Record<string, string>> = {
  "full-time": "FULL_TIME",
  "part-time": "PART_TIME",
  contract: "CONTRACT",
  temporary: "TEMPORARY",
  internship: "INTERNSHIP",
  intern: "INTERNSHIP",
  trainee: "INTERNSHIP",
};

/**
 * Camada 2 — o Anti-Corruption Layer propriamente dito.
 *
 * Nada de `WorkableJobDto` atravessa esta função: o que sai é `JobPosting`, que
 * o resto do sistema entende sem saber que o Workable existe.
 *
 * Esta é a única das quatro fontes do PR que publica o NOME da empresa
 * (`accountName`, do topo da resposta). O slug continua vindo da tarefa porque
 * é ele que é estável: o nome é texto de exibição e pode ser reescrito no
 * painel a qualquer momento.
 *
 * Nota sobre salário: o widget do Workable **não expõe faixa salarial** em
 * nível nenhum da resposta (verificado no payload real). Por isso
 * `compensation` é sempre `null` aqui — como no Gupy, inventar um valor seria
 * pior que a ausência.
 */
export function toJobPosting(
  dto: WorkableJobDto,
  boardSlug: string,
  accountName: string | null | undefined,
  seenAt: Date,
): JobPosting {
  const props: JobPostingProps = {
    source: {
      id: WORKABLE_SOURCE_ID,
      externalId: dto.shortcode,
      url: dto.url,
    },
    company: {
      name: accountName?.trim() || boardSlug,
      slug: boardSlug,
    },
    title: dto.title.trim(),
    // `description` do ITEM, nunca a do topo — a do topo é da empresa e seria
    // idêntica em todas as vagas do board.
    description: RichText.fromHtml(dto.description ?? ""),
    location: buildLocation(dto),
    compensation: null,
    employmentType:
      EMPLOYMENT_TYPE_BY_WORKABLE[dto.employment_type?.trim().toLowerCase() ?? ""] ?? null,
    postedAt: parseDate(dto.published_on) ?? parseDate(dto.created_at),
    seenAt,
  };

  return JobPosting.create(props);
}

/**
 * A localização vem esfarelada em `city`/`state`/`country`, com partes vazias
 * (na `blueground`, vaga remota nos EUA tem `city: ""` e `state: ""`), então o
 * texto livre é remontado aqui filtrando o que está em branco. Sem o filtro,
 * `raw` viraria ", , United States" e a inferência de cidade pegaria a string
 * vazia como cidade.
 *
 * `telecommuting` é o ÚNICO sinal de modalidade que a fonte dá — não há
 * equivalente de "híbrido". Por isso `false` vira `UNKNOWN`, e não `ONSITE`:
 * "não marcaram remoto" não é o mesmo que "afirmaram presencial", e cravar
 * ONSITE encheria a faceta de presencial com vagas que ninguém classificou.
 *
 * O país vem em `locations[].countryCode` já em ISO-2; `country` do item é o
 * nome por extenso e só entra no texto livre.
 */
function buildLocation(dto: WorkableJobDto): Location {
  const parts = [dto.city, dto.state, dto.country].map((part) => part?.trim()).filter(Boolean);
  const raw = parts.join(", ");

  const remote = dto.telecommuting === true ? RemoteMode.REMOTE : RemoteMode.UNKNOWN;
  const country = dto.locations?.[0]?.countryCode?.trim().toUpperCase();

  return Location.fromRaw(raw, {
    remote,
    ...(country ? { country } : {}),
  });
}

/** `published_on` é data sem hora ("2026-08-18"), interpretada como UTC. */
function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

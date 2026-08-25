export enum Seniority {
  INTERN = "INTERN",
  JUNIOR = "JUNIOR",
  MID = "MID",
  SENIOR = "SENIOR",
  STAFF = "STAFF",
  PRINCIPAL = "PRINCIPAL",
  MANAGER = "MANAGER",
  UNKNOWN = "UNKNOWN",
}

/**
 * Ordem importa: a primeira regra que casar vence. Os níveis mais específicos
 * vêm antes — "senior staff engineer" tem que virar STAFF, não SENIOR, e
 * "estágio" tem que vencer qualquer outro sinal na mesma string.
 *
 * As fronteiras são apertadas de propósito. A versão anterior usava `\w*` para
 * cobrir as flexões do português (estagi-ário, estagi-o) e, com isso, `intern`
 * passou a casar dentro de "internal" e "international" — em descrição longa
 * em inglês, 10 das 15 vagas do board do Greenhouse viravam INTERN, incluindo
 * "Engineering Manager". Cada radical agora fecha na própria flexão.
 */
const RULES: ReadonlyArray<readonly [Seniority, RegExp]> = [
  [Seniority.INTERN, /\best[áa]gi\w*|\bintern(?:ship)?s?\b|\btrainees?\b|\baprendiz(?:es)?\b/i],
  [Seniority.PRINCIPAL, /\b(principal|distinguished|fellow)\b/i],
  // "staff" e "architect" soltos são armadilhas em texto corrido: "our staff"
  // quer dizer funcionários, e "a change architect" é metáfora de descrição de
  // RH — foi assim que um "Director, People Systems" virou STAFF. Como NÍVEL,
  // os dois vêm sempre colados ao cargo, e é isso que a regra passa a exigir.
  // "arquiteto/a" fica solto porque em português não tem o uso figurado.
  [
    Seniority.STAFF,
    /\bstaff\s+(?:engineer|software|developer|scientist|designer|architect|data)\b|\b(?:solutions?|software|cloud|data|security|systems?|enterprise|technical|infrastructure)\s+architect\b|\barquitet[oa]\b/i,
  ],
  [Seniority.MANAGER, /\b(manager|gerente|head\s+of|coordenador[a]?|tech\s+lead|l[íi]der)\b/i],
  [Seniority.SENIOR, /\b(s[êe]nior|senior|sr\.?|especialista|expert)\b/i],
  [Seniority.JUNIOR, /\b(j[úu]nior|junior|jr\.?|entry[- ]level)\b/i],
  [Seniority.MID, /\b(pleno|mid[- ]?level|middle|pl\.?)\b/i],
];

function match(text: string | null | undefined): Seniority {
  if (!text?.trim()) return Seniority.UNKNOWN;

  for (const [seniority, pattern] of RULES) {
    if (pattern.test(text)) return seniority;
  }
  return Seniority.UNKNOWN;
}

/**
 * Extração determinística: versionada, grátis, testável e reproduzível.
 * Um enricher com LLM entra depois atrás de uma porta própria, rodando só
 * sobre o delta (vagas cujo `contentHash` mudou) — o custo escala com volume.
 *
 * O título tem precedência sobre a descrição, e não é preferência de estilo:
 * senioridade é uma afirmação que o título FAZ, enquanto a descrição só
 * MENCIONA níveis — fala do programa de estágio da empresa, do time sênior que
 * você vai integrar, de quem você reporta. Ler os dois no mesmo balaio faz o
 * ruído da descrição vencer o sinal do título. A descrição continua sendo lida
 * quando o título não afirma nada, porque fonte com título pobre existe e um
 * palpite fraco ainda é melhor que UNKNOWN.
 */
export function inferSeniority(
  title: string | null | undefined,
  description?: string | null,
): Seniority {
  const fromTitle = match(title);
  return fromTitle === Seniority.UNKNOWN ? match(description) : fromTitle;
}

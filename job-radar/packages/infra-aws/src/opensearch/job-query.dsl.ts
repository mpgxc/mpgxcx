import { type JobQuery, MAX_RESULT_WINDOW } from "@job-radar/core";

/**
 * `JobQuery` -> corpo do `_search`.
 *
 * Função PURA e exportada de propósito: é o pedaço do adapter que mais fácil
 * quebra em silêncio (um `terms` no campo errado devolve zero resultado sem
 * erro nenhum) e o único que dá para testar sem cluster. Mesma razão de
 * `fetch` e `parse` serem métodos separados na porta de fonte.
 */
export function buildSearchBody(query: JobQuery): Record<string, unknown> {
  const filter: Record<string, unknown>[] = [];

  // Dentro da faceta, OU — é isso que `terms` significa. Entre facetas, E —
  // é isso que estar na mesma lista de `filter` significa.
  if (query.stack.length > 0) filter.push({ terms: { stack: query.stack } });
  if (query.seniority.length > 0) filter.push({ terms: { seniority: query.seniority } });
  if (query.remote.length > 0) filter.push({ terms: { remote: query.remote } });
  if (query.countries.length > 0) filter.push({ terms: { country: query.countries } });

  if (query.salary) {
    /**
     * Interseção de faixas, não contenção: a vaga entra se a faixa dela
     * encosta na faixa pedida em algum ponto. "A partir de 15k" tem que
     * aparecer para quem pediu "até 20k".
     *
     * Consequência deliberada: vaga SEM salário publicado não casa nenhum
     * filtro de salário. Não dá para provar que ela está na faixa, e incluí-la
     * "no benefício da dúvida" faria o filtro devolver justamente as vagas
     * sobre as quais ele não sabe nada — que é a maioria delas.
     */
    filter.push({ term: { "salary.currency": query.salary.currency } });
    if (query.salary.minCents !== null) {
      filter.push({ range: { "salary.ceilingCents": { gte: query.salary.minCents } } });
    }
    if (query.salary.maxCents !== null) {
      filter.push({ range: { "salary.floorCents": { lte: query.salary.maxCents } } });
    }
  }

  if (query.postedAfter || query.postedBefore) {
    filter.push({
      range: {
        postedAt: {
          ...(query.postedAfter ? { gte: query.postedAfter } : {}),
          ...(query.postedBefore ? { lte: query.postedBefore } : {}),
        },
      },
    });
  }

  const must = query.text
    ? [
        {
          multi_match: {
            query: query.text,
            /**
             * Pesos, não campos iguais: o título AFIRMA o que a vaga é, a
             * descrição só menciona. É a mesma assimetria que a inferência de
             * senioridade explora, e ignorá-la faz qualquer vaga que cite
             * "Kubernetes" no meio do texto competir com a vaga DE Kubernetes.
             */
            fields: ["title^4", "companyName^2", "stack^2", "description", "locationRaw"],
            type: "best_fields",
            /**
             * `and` e não o `or` padrão: com `or`, "engenheiro de dados"
             * devolve tudo que contém "de". O usuário que digitou três
             * palavras quer as três.
             */
            operator: "and",
          },
        },
      ]
    : [];

  return {
    from: query.offset,
    size: query.size,
    /**
     * Contar só até a janela. O padrão do OpenSearch pára em 10.000 e reporta
     * `gte`; aqui o teto é o mesmo que o domínio já recusa paginar, então
     * contar além disso seria varrer a coleção para exibir um número que
     * ninguém consegue alcançar.
     */
    track_total_hits: MAX_RESULT_WINDOW,
    query:
      must.length === 0 && filter.length === 0
        ? { match_all: {} }
        : {
            bool: {
              ...(must.length > 0 ? { must } : {}),
              ...(filter.length > 0 ? { filter } : {}),
            },
          },
    sort: buildSort(query),
    // `url` e `contentHash` viajam de volta para a borda; nada mais é omitido
    // porque o documento inteiro é pequeno e o cliente exibe quase tudo.
    _source: true,
  };
}

/**
 * Toda ordenação termina em `id`.
 *
 * Sem desempate estável, dois documentos com o mesmo score (ou a mesma data)
 * podem trocar de posição entre duas requisições — e quem pagina vê o mesmo
 * item duas vezes e perde outro. É um bug que só aparece em produção, com
 * dados reais e empate real.
 */
function buildSort(query: JobQuery): unknown[] {
  const tiebreak = { id: { order: "asc" } };

  switch (query.sort) {
    case "RELEVANCE":
      return [{ _score: { order: "desc" } }, tiebreak];
    case "SALARY":
      // `missing: _last` porque a maioria das vagas não publica salário, e
      // elas não podem ocupar o topo de uma ordenação POR salário.
      return [{ "salary.ceilingCents": { order: "desc", missing: "_last" } }, tiebreak];
    case "RECENT":
      // `postedAt` é o que o candidato quer; `lastSeenAt` cobre a fonte que
      // não publica data, para a vaga não afundar por falta de campo.
      return [
        { postedAt: { order: "desc", missing: "_last" } },
        { lastSeenAt: { order: "desc" } },
        tiebreak,
      ];
  }
}

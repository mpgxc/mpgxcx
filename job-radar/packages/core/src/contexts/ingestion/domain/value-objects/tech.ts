/**
 * `go` é o único termo do dicionário que colide com uma palavra comum do
 * inglês, e a colisão é devastadora: como verbo ("go deep", "ready to go",
 * "go-to-market"), ele aparece em praticamente toda descrição longa — as 15
 * vagas do board do Greenhouse eram taggeadas com `go`, nenhuma delas de Go.
 * Uma tag errada em quase todo mundo não degrada a busca, ela inutiliza a
 * faceta.
 *
 * Por isso este termo, e só ele, exige contexto de linguagem em vez de
 * fronteira: `golang`, o cargo ("Go developer"), a preposição que introduz
 * tecnologia ("in Go", "with Go") ou a lista de linguagens ("Python, Go,
 * Rust"). Perde-se o "Go" solto e sem vizinhança — troca deliberada de recall
 * por precisão, porque aqui o falso positivo é o erro caro.
 */
const GO_IN_CONTEXT =
  /(?<=\b(?:in|with|using|em|com|know|knows|learn|write|writing|written|prefer|experience|proficient)\s+)go\b(?!-)|\bgo\s+(?:developer|engineer|programmer|programming|services?|microservices?|codebase|module|routines?|lang)\b|(?<=[,/]\s?)go(?=\s*[,/])/i;

/**
 * Dicionário de stack. Cada entrada é `[tag canônica, padrões]`.
 *
 * Os padrões são casados com fronteira de palavra construída na mão porque
 * `\b` não funciona com `c++`, `c#`, `.net` e `node.js` — os caracteres finais
 * não são word chars, então `\b` nunca fecha. Esse detalhe é justamente o que
 * quebra silenciosamente a maioria dos extratores caseiros.
 */
const DICTIONARY: ReadonlyArray<readonly [tag: string, patterns: readonly (string | RegExp)[]]> = [
  ["typescript", ["typescript", "ts"]],
  ["javascript", ["javascript", "js", "ecmascript"]],
  ["node", ["node.js", "nodejs", "node"]],
  ["react", ["react.js", "reactjs", "react"]],
  ["nextjs", ["next.js", "nextjs"]],
  ["vue", ["vue.js", "vuejs", "vue"]],
  ["angular", ["angular"]],
  ["python", ["python"]],
  ["django", ["django"]],
  ["fastapi", ["fastapi"]],
  ["java", ["java"]],
  ["kotlin", ["kotlin"]],
  ["spring", ["spring boot", "spring"]],
  ["go", ["golang", GO_IN_CONTEXT]],
  ["rust", ["rust"]],
  ["ruby", ["ruby on rails", "rails", "ruby"]],
  ["php", ["php", "laravel"]],
  ["csharp", ["c#", "csharp", ".net", "dotnet"]],
  ["cpp", ["c++", "cpp"]],
  ["elixir", ["elixir", "phoenix"]],
  ["scala", ["scala"]],
  ["swift", ["swift"]],
  ["postgres", ["postgresql", "postgres"]],
  ["mysql", ["mysql", "mariadb"]],
  ["mongodb", ["mongodb", "mongo"]],
  ["redis", ["redis"]],
  ["dynamodb", ["dynamodb"]],
  ["elasticsearch", ["elasticsearch", "opensearch"]],
  ["kafka", ["kafka"]],
  ["rabbitmq", ["rabbitmq"]],
  ["graphql", ["graphql"]],
  ["grpc", ["grpc"]],
  ["aws", ["aws", "amazon web services"]],
  ["gcp", ["gcp", "google cloud"]],
  ["azure", ["azure"]],
  ["docker", ["docker"]],
  ["kubernetes", ["kubernetes", "k8s"]],
  ["terraform", ["terraform"]],
  ["serverless", ["serverless", "lambda"]],
  ["nestjs", ["nest.js", "nestjs"]],
  ["flutter", ["flutter"]],
  ["android", ["android"]],
  ["ios", ["ios"]],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fronteira própria: exige que o termo não seja precedido nem seguido por
 * letra/dígito. Assim `go` não casa dentro de "google" nem de "django", e
 * `c++` continua casando apesar do `+`.
 */
const BOUNDARY_BEFORE = "(?<![a-z0-9+#.])";
const BOUNDARY_AFTER = "(?![a-z0-9+#])";

/**
 * Termo literal ganha a fronteira construída acima; termo que já vem como
 * RegExp entra inteiro, porque ele traz a própria noção de fronteira — é a
 * válvula de escape para os poucos casos em que "casar a palavra" não basta.
 */
const COMPILED: ReadonlyArray<readonly [string, RegExp]> = DICTIONARY.map(([tag, patterns]) => {
  const alternation = patterns
    .map((pattern) =>
      typeof pattern === "string"
        ? `${BOUNDARY_BEFORE}(?:${escapeRegExp(pattern)})${BOUNDARY_AFTER}`
        : `(?:${pattern.source})`,
    )
    .join("|");
  return [tag, new RegExp(alternation, "i")] as const;
});

/** Tags canônicas ordenadas — determinístico, então o `contentHash` é estável. */
export function extractStack(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const haystack = texts.filter(Boolean).join(" \n ").toLowerCase();
  if (!haystack.trim()) return [];

  const found = COMPILED.filter(([, pattern]) => pattern.test(haystack)).map(([tag]) => tag);
  return [...new Set(found)].sort();
}

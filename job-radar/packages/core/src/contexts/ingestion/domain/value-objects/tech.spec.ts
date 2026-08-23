import { describe, expect, it } from "vitest";
import { extractStack } from "./tech.js";

describe("extractStack — fronteiras de palavra", () => {
  it("não confunde 'go' com substring de outra palavra", () => {
    // O caso clássico: `\bgo\b` acha "go" dentro de "Django" via hífen/pontuação
    // e dicionários ingênuos marcam Go em toda vaga de Python.
    expect(extractStack("Vaga de Django e Google Cloud")).not.toContain("go");
    expect(extractStack("Experiência com Go e Kubernetes")).toContain("go");
  });

  it("casa linguagens cujo nome termina em símbolo", () => {
    // `\b` nunca fecha depois de '+' ou '#', então essas três somem
    // silenciosamente de um extrator baseado em \b.
    expect(extractStack("Desenvolvedor C++ sênior")).toContain("cpp");
    expect(extractStack("Vaga para C# / .NET")).toContain("csharp");
    expect(extractStack("Back-end em Node.js")).toContain("node");
  });

  it("não marca 'ts' dentro de palavras comuns", () => {
    expect(extractStack("Gerenciar events e reports")).not.toContain("typescript");
    expect(extractStack("Stack: TS + React")).toContain("typescript");
  });

  it("devolve tags canônicas ordenadas e sem repetição", () => {
    const stack = extractStack("React, ReactJS e react.js com TypeScript e typescript");
    expect(stack).toEqual(["react", "typescript"]);
  });

  it("devolve vazio para texto sem tecnologia", () => {
    expect(extractStack("Vaga para auxiliar administrativo")).toEqual([]);
    expect(extractStack(null, undefined, "")).toEqual([]);
  });

  it("é estável entre chamadas — o contentHash depende disso", () => {
    const text = "Node.js, AWS Lambda, DynamoDB e TypeScript";
    expect(extractStack(text)).toEqual(extractStack(text));
  });
});

describe("extractStack — `go` exige contexto de linguagem", () => {
  it("ignora 'go' como verbo comum do inglês", () => {
    // A fronteira de palavra resolvia "Django"/"Google", mas não o verbo solto:
    // as 15 vagas do board do Greenhouse eram taggeadas com `go`, nenhuma de Go.
    // Uma tag errada em quase todo mundo não degrada a faceta, inutiliza.
    expect(extractStack("You will go deep on distributed systems.")).toEqual([]);
    expect(extractStack("We are ready to go and iterate fast.")).toEqual([]);
    expect(extractStack("Experience in go-to-market strategy")).toEqual([]);
  });

  it("reconhece Go quando a vizinhança é de linguagem", () => {
    expect(extractStack("Golang developer")).toContain("go");
    expect(extractStack("Strong experience with Go")).toContain("go");
    expect(extractStack("Hiring a Go engineer for the platform")).toContain("go");
    expect(extractStack("Our stack: Python, Go, Rust")).toEqual(["go", "python", "rust"]);
  });
});

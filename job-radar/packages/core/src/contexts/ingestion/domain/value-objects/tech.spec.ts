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

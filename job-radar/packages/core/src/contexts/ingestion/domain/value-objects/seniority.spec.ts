import { describe, expect, it } from "vitest";
import { inferSeniority, Seniority } from "./seniority.js";

describe("inferSeniority — precedência entre sinais concorrentes", () => {
  it("prioriza o nível mais específico quando dois sinais coexistem", () => {
    // "Senior Staff Engineer" é STAFF, não SENIOR. A ordem das regras é a regra.
    expect(inferSeniority("Senior Staff Engineer")).toBe(Seniority.STAFF);
    expect(inferSeniority("Principal Software Engineer")).toBe(Seniority.PRINCIPAL);
  });

  it("estágio vence qualquer outro sinal na mesma string", () => {
    expect(inferSeniority("Estágio em Engenharia de Software Pleno")).toBe(Seniority.INTERN);
  });

  it("entende os níveis em português", () => {
    expect(inferSeniority("Desenvolvedor Backend Júnior")).toBe(Seniority.JUNIOR);
    expect(inferSeniority("Pessoa Desenvolvedora Pleno")).toBe(Seniority.MID);
    expect(inferSeniority("Engenheiro de Dados Sênior")).toBe(Seniority.SENIOR);
    expect(inferSeniority("Tech Lead de Plataforma")).toBe(Seniority.MANAGER);
  });

  it("aceita abreviações", () => {
    expect(inferSeniority("Backend Engineer Sr.")).toBe(Seniority.SENIOR);
    expect(inferSeniority("Dev Jr")).toBe(Seniority.JUNIOR);
  });

  it("devolve UNKNOWN em vez de chutar", () => {
    // Fingir certeza aqui polui a busca — ausência de sinal é um estado legítimo.
    expect(inferSeniority("Desenvolvedor de Software")).toBe(Seniority.UNKNOWN);
    expect(inferSeniority(null, undefined, "  ")).toBe(Seniority.UNKNOWN);
  });
});

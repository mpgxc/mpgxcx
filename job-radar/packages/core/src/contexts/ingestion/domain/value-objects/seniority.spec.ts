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
    expect(inferSeniority(null, "  ")).toBe(Seniority.UNKNOWN);
  });
});

describe("inferSeniority — fronteiras que a descrição em inglês expôs", () => {
  it("não confunde 'internal'/'international' com estágio", () => {
    // A regressão que motivou a fronteira apertada: com `\w*` no fim do radical,
    // 10 das 15 vagas do board do Greenhouse viravam INTERN por causa da
    // descrição — "Engineering Manager" inclusive.
    const description = "We build internal tooling for international teams.";
    expect(inferSeniority("Engineering Manager", description)).toBe(Seniority.MANAGER);
    expect(inferSeniority("Software Engineer", description)).toBe(Seniority.UNKNOWN);
    expect(inferSeniority("Software Engineer Intern")).toBe(Seniority.INTERN);
    expect(inferSeniority("Summer 2026 Internship — Backend")).toBe(Seniority.INTERN);
  });

  it("não confunde 'staff' no sentido de funcionários com o nível STAFF", () => {
    expect(inferSeniority("Recruiter", "You will support our staff and their needs.")).toBe(
      Seniority.UNKNOWN,
    );
    expect(inferSeniority("Staff Software Engineer")).toBe(Seniority.STAFF);
  });

  it("'trainee' é estágio, 'trained' não é", () => {
    expect(inferSeniority("Programa Trainee 2026")).toBe(Seniority.INTERN);
    expect(inferSeniority("Backend Engineer", "You will be trained on our stack.")).toBe(
      Seniority.UNKNOWN,
    );
  });

  it("'aprendiz' é estágio, 'aprendizado' não é", () => {
    expect(inferSeniority("Jovem Aprendiz")).toBe(Seniority.INTERN);
    expect(inferSeniority("Pessoa Desenvolvedora", "Ambiente de aprendizado contínuo.")).toBe(
      Seniority.UNKNOWN,
    );
  });
});

describe("inferSeniority — precedência do título sobre a descrição", () => {
  it("o título vence quando afirma alguma coisa", () => {
    // A descrição menciona o programa de estágio da empresa; o cargo não é de estágio.
    expect(inferSeniority("Senior Backend Engineer", "We also run an internship program.")).toBe(
      Seniority.SENIOR,
    );
  });

  it("a descrição só entra quando o título nada afirma", () => {
    expect(inferSeniority("Pessoa Desenvolvedora", "Vaga para nível pleno.")).toBe(Seniority.MID);
  });
});

describe("inferSeniority — 'architect' precisa ser o cargo, não a metáfora", () => {
  it("ignora 'architect' usado como figura de linguagem", () => {
    // Caso real do board do Greenhouse: "A change architect – you are energized
    // by leading through systems upgrades" numa vaga de RH.
    expect(
      inferSeniority("Director, People Systems", "A change architect who leads through change."),
    ).toBe(Seniority.UNKNOWN);
  });

  it("reconhece o cargo quando vem qualificado", () => {
    expect(inferSeniority("Solutions Architect")).toBe(Seniority.STAFF);
    expect(inferSeniority("Senior Cloud Architect")).toBe(Seniority.STAFF);
    expect(inferSeniority("Arquiteta de Software")).toBe(Seniority.STAFF);
  });
});

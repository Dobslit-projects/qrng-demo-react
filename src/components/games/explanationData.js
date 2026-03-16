/**
 * Conteúdo educativo para cada visualização do comparador PRNG vs QRNG.
 * Chaves correspondem aos mode keys em QuantumVisualizer (MODES[].key).
 */
export const explanations = {
  galaxy: {
    title: "Espiral Galáctica",
    algorithm: {
      heading: "Como funciona",
      bullets: [
        "900 estrelas distribuídas em 3 braços espirais logarítmicos",
        "Velocidade angular Kepleriana (inversamente proporcional ao raio)",
        "2 bytes por estrela definem posição inicial e brilho",
        "A cada ~6 segundos, novos bytes perturbam ângulos e cintilação",
      ],
    },
    differences: {
      heading: "Diferenças visuais",
      prng:
        "Braços rígidos e artificiais. Estrelas se agrupam em posições previsíveis com gaps visíveis. Brilho repetitivo.",
      qrng:
        "Estrutura espiral orgânica. Distribuição suave com variação natural de brilho e posição. Sem padrões repetitivos.",
    },
    why: {
      heading: "Por que isso acontece",
      prng: "8 níveis → apenas 8 raios distintos, criando 'anéis' concêntricos e braços com 'degraus'",
      qrng: "256 níveis → distribuição contínua preenchendo todo o espaço de parâmetros",
    },
    stats: [
      { label: "Bytes/rebuild", value: "900" },
      { label: "Estrelas", value: "900" },
      { label: "Braços", value: "3 espirais" },
      { label: "Perturbação", value: "~6s" },
    ],
  },

  mandala: {
    title: "Mandala Simétrica",
    algorithm: {
      heading: "Como funciona",
      bullets: [
        "Pontos adicionados a cada 8 frames usando 2 bytes (ângulo + raio)",
        "Raio com mapeamento quadrático: r = rawR² × 0.42 + 0.05",
        "Cada ponto é replicado 8× por simetria rotacional e espelhamento",
        "Grade 100×100 e sparkline mostram cobertura em tempo real",
      ],
    },
    differences: {
      heading: "Diferenças visuais",
      prng:
        "Setores mal preenchidos com lacunas. Pontos se acumulam nos mesmos ângulos/raios. Cobertura baixa.",
      qrng:
        "Distribuição uniforme e simétrica. Cobertura consistente e significativamente maior. Mandala visualmente completa.",
    },
    why: {
      heading: "Por que isso acontece",
      prng: "8 ângulos × 8 raios = 64 posições únicas × 8 simetrias = apenas 512 pontos possíveis",
      qrng: "256 × 256 = 65.536 combinações únicas, preenchimento dramaticamente mais completo",
    },
    stats: [
      { label: "Bytes/burst", value: "2" },
      { label: "Simetria", value: "8× rotação" },
      { label: "Grade", value: "100×100" },
      { label: "Reset", value: "~25s" },
    ],
  },

  cracker: {
    title: "Quebra do LCG",
    algorithm: {
      heading: "Como funciona",
      bullets: [
        "LCG produz: X(n+1) = a · X(n) + c mod m",
        "Com 3 saídas consecutivas, o atacante recupera 'a' e 'c'",
        "Método: inversão modular — a = (X₂−X₁) · (X₁−X₀)⁻¹ mod 2³²",
        "Sonificação pentatônica: predição toca 80ms ANTES do byte real",
      ],
    },
    differences: {
      heading: "Diferenças visuais e sonoras",
      prng:
        "Após 3 saídas, TODAS as futuras são previstas com 100% de acerto. Sons se fundem em uníssono perfeito.",
      qrng:
        "Predições falham (~0.4% por sorte). Sons colidem em dissonância — cada byte é imprevisível.",
    },
    why: {
      heading: "Por que isso acontece",
      prng: "Estado interno de 32 bits, completamente determinístico — 3 saídas = sistema linear resolvido",
      qrng: "Flutuações quânticas de vácuo — sem estado interno, imprevisibilidade fundamental",
    },
    stats: [
      { label: "Saídas p/ quebra", value: "3" },
      { label: "Módulo", value: "2³²" },
      { label: "Método", value: "Inversão modular" },
      { label: "Som", value: "Pentatônica" },
    ],
  },

  mtclone: {
    title: "Clone do MT19937",
    algorithm: {
      heading: "Como funciona",
      bullets: [
        "MT19937 mantém estado de 624 palavras de 32 bits (19.937 bits)",
        "Cada saída passa por 'tempering' — 4 operações bitwise reversíveis",
        "Coletando 624 saídas + untempering → estado interno completo",
        "Após clonagem, 100% de predição em todas as saídas futuras",
      ],
    },
    differences: {
      heading: "Diferenças visuais e sonoras",
      prng:
        "Grade de 624 células se ilumina durante coleta. Após 'CLONADO!', 100% de acerto — sons em uníssono.",
      qrng:
        "Mesmo após 624 saídas, nenhum padrão. Clone falha completamente — bytes quânticos permanecem imprevisíveis.",
    },
    why: {
      heading: "Por que isso acontece",
      prng: "Determinístico: 624 palavras fixam toda a sequência. Tempering é bijetivo (reversível)",
      qrng: "Sem estado computacional — cada medição quântica é um evento físico único e irreproduzível",
    },
    stats: [
      { label: "Estado", value: "624×32 bits" },
      { label: "Saídas p/ clone", value: "624" },
      { label: "Período", value: "2¹⁹⁹³⁷−1" },
      { label: "Método", value: "Untempering" },
    ],
  },

  sonification: {
    title: "Sonificação (Piano Roll)",
    algorithm: {
      heading: "Como funciona",
      bullets: [
        "Cada byte → 1 de 15 notas pentatônicas (C4 a A6, 3 oitavas)",
        "~6 notas/segundo (1 nota a cada 10 frames)",
        "Piano roll com scroll horizontal mostra histórico de ~5 segundos",
        "Histograma à direita mostra distribuição de frequência acumulada",
      ],
    },
    differences: {
      heading: "Diferenças visuais e sonoras",
      prng:
        "Apenas 8 de 15 notas tocadas. 7 linhas do piano roll ficam vazias. Som repetitivo e mecânico.",
      qrng:
        "Todas as 15 notas com distribuição uniforme. Piano roll completo. Som variado e orgânico.",
    },
    why: {
      heading: "Por que isso acontece",
      prng: "8 níveis → bytes restritos caem nos índices pares (0,2,4,...), 7 notas ímpares ausentes",
      qrng: "256 níveis distribuem bytes por todas as 15 notas uniformemente",
    },
    stats: [
      { label: "Notas", value: "15 pentatônicas" },
      { label: "Taxa", value: "~6/s" },
      { label: "Histórico", value: "~5 segundos" },
      { label: "Níveis PRNG", value: "8 (7 ausentes)" },
    ],
  },
};

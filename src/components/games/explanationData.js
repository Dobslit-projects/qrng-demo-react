/**
 * Conteúdo educativo para cada visualização do comparador PRNG vs QRNG.
 * Chaves correspondem aos mode keys em QuantumVisualizer (MODES[].key).
 * Bilíngue (pt/en) -- InfoModal seleciona pelo idioma ativo (LanguageContext).
 */
export const explanations = {
  pt: {
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
  },

  en: {
    galaxy: {
      title: "Galactic Spiral",
      algorithm: {
        heading: "How it works",
        bullets: [
          "900 stars distributed across 3 logarithmic spiral arms",
          "Keplerian angular velocity (inversely proportional to radius)",
          "2 bytes per star define initial position and brightness",
          "Every ~6 seconds, new bytes perturb angles and flicker",
        ],
      },
      differences: {
        heading: "Visual differences",
        prng:
          "Rigid, artificial arms. Stars cluster at predictable positions with visible gaps. Repetitive brightness.",
        qrng:
          "Organic spiral structure. Smooth distribution with natural variation in brightness and position. No repeating patterns.",
      },
      why: {
        heading: "Why this happens",
        prng: "8 levels → only 8 distinct radii, creating concentric 'rings' and 'stepped' arms",
        qrng: "256 levels → continuous distribution filling the whole parameter space",
      },
      stats: [
        { label: "Bytes/rebuild", value: "900" },
        { label: "Stars", value: "900" },
        { label: "Arms", value: "3 spirals" },
        { label: "Perturbation", value: "~6s" },
      ],
    },

    mandala: {
      title: "Symmetric Mandala",
      algorithm: {
        heading: "How it works",
        bullets: [
          "Points added every 8 frames using 2 bytes (angle + radius)",
          "Quadratic radius mapping: r = rawR² × 0.42 + 0.05",
          "Each point is replicated 8× via rotational symmetry and mirroring",
          "100×100 grid and sparkline show coverage in real time",
        ],
      },
      differences: {
        heading: "Visual differences",
        prng:
          "Poorly filled sectors with gaps. Points cluster at the same angles/radii. Low coverage.",
        qrng:
          "Uniform, symmetric distribution. Consistent, significantly higher coverage. Visually complete mandala.",
      },
      why: {
        heading: "Why this happens",
        prng: "8 angles × 8 radii = 64 unique positions × 8 symmetries = only 512 possible points",
        qrng: "256 × 256 = 65,536 unique combinations, dramatically more complete fill",
      },
      stats: [
        { label: "Bytes/burst", value: "2" },
        { label: "Symmetry", value: "8× rotation" },
        { label: "Grid", value: "100×100" },
        { label: "Reset", value: "~25s" },
      ],
    },

    cracker: {
      title: "LCG Cracking",
      algorithm: {
        heading: "How it works",
        bullets: [
          "The LCG produces: X(n+1) = a · X(n) + c mod m",
          "With 3 consecutive outputs, the attacker recovers 'a' and 'c'",
          "Method: modular inversion — a = (X₂−X₁) · (X₁−X₀)⁻¹ mod 2³²",
          "Pentatonic sonification: prediction plays 80ms BEFORE the real byte",
        ],
      },
      differences: {
        heading: "Visual and audio differences",
        prng:
          "After 3 outputs, ALL future ones are predicted with 100% accuracy. Sounds merge into perfect unison.",
        qrng:
          "Predictions fail (~0.4% by chance). Sounds collide in dissonance — every byte is unpredictable.",
      },
      why: {
        heading: "Why this happens",
        prng: "32-bit internal state, fully deterministic — 3 outputs = a solved linear system",
        qrng: "Quantum vacuum fluctuations — no internal state, fundamental unpredictability",
      },
      stats: [
        { label: "Outputs to crack", value: "3" },
        { label: "Modulus", value: "2³²" },
        { label: "Method", value: "Modular inversion" },
        { label: "Sound", value: "Pentatonic" },
      ],
    },

    mtclone: {
      title: "MT19937 Clone",
      algorithm: {
        heading: "How it works",
        bullets: [
          "MT19937 keeps a state of 624 32-bit words (19,937 bits)",
          "Each output goes through 'tempering' — 4 reversible bitwise operations",
          "Collecting 624 outputs + untempering → full internal state",
          "After cloning, 100% prediction on all future outputs",
        ],
      },
      differences: {
        heading: "Visual and audio differences",
        prng:
          "A 624-cell grid lights up during collection. After 'CLONED!', 100% accuracy — sounds in unison.",
        qrng:
          "Even after 624 outputs, no pattern. Cloning fails completely — quantum bytes remain unpredictable.",
      },
      why: {
        heading: "Why this happens",
        prng: "Deterministic: 624 words fix the entire sequence. Tempering is bijective (reversible)",
        qrng: "No computational state — each quantum measurement is a unique, unreproducible physical event",
      },
      stats: [
        { label: "State", value: "624×32 bits" },
        { label: "Outputs to clone", value: "624" },
        { label: "Period", value: "2¹⁹⁹³⁷−1" },
        { label: "Method", value: "Untempering" },
      ],
    },

    sonification: {
      title: "Sonification (Piano Roll)",
      algorithm: {
        heading: "How it works",
        bullets: [
          "Each byte → 1 of 15 pentatonic notes (C4 to A6, 3 octaves)",
          "~6 notes/second (1 note every 10 frames)",
          "Horizontally scrolling piano roll shows ~5 seconds of history",
          "Histogram on the right shows accumulated frequency distribution",
        ],
      },
      differences: {
        heading: "Visual and audio differences",
        prng:
          "Only 8 of 15 notes are played. 7 piano-roll lines stay empty. Repetitive, mechanical sound.",
        qrng:
          "All 15 notes with uniform distribution. Complete piano roll. Varied, organic sound.",
      },
      why: {
        heading: "Why this happens",
        prng: "8 levels → restricted bytes fall on even indices (0,2,4,...), 7 odd notes missing",
        qrng: "256 levels spread bytes across all 15 notes uniformly",
      },
      stats: [
        { label: "Notes", value: "15 pentatonic" },
        { label: "Rate", value: "~6/s" },
        { label: "History", value: "~5 seconds" },
        { label: "PRNG levels", value: "8 (7 missing)" },
      ],
    },
  },
};

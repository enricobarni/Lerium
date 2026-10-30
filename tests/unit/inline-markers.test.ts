import { describe, expect, it } from 'vitest';
import {
  countMarkerSyntax,
  decodeMarkers,
  encodeMarkers,
  MAX_INLINE_DEPTH,
  MAX_INLINE_WRAPPERS,
  validateInlineLayout,
  type InlineLayout,
  type InlineRun,
} from '../../src/core/inline-markers';

const layoutOf = (...runs: [string, number[]][]): InlineLayout => ({
  runs: runs.map(([text, path]) => ({ text, path })),
});

/** "the <em>red</em> stone" */
const RED_STONE = layoutOf(['the ', []], ['red', [1]], [' stone', []]);
/** "She <a>took the <strong>blade</strong> back</a>." */
const NESTED = layoutOf(
  ['She ', []],
  ['took the ', [1]],
  ['blade', [1, 2]],
  [' back', [1]],
  ['.', []],
);
/** "A <em>x</em> B <em>y</em> C" */
const TWO_SPANS = layoutOf(['A ', []], ['x', [1]], [' B ', []], ['y', [2]], [' C', []]);
/** "<em>Red</em><strong>Blue</strong> sky" */
const ADJACENT_AT_START = layoutOf(['Red', [1]], ['Blue', [2]], [' sky', []]);

const texts = (layout: InlineLayout): string[] => layout.runs.map((run) => run.text);

describe('encodeMarkers', () => {
  it('aninha os marcadores', () => {
    expect(encodeMarkers(NESTED)).toBe('She <g1>took the <g2>blade</g2> back</g1>.');
  });

  it('fecha e abre marcadores colados sem texto entre eles', () => {
    expect(encodeMarkers(ADJACENT_AT_START)).toBe('<g1>Red</g1><g2>Blue</g2> sky');
    expect(encodeMarkers(layoutOf(['a', [1, 2]], ['b', [1, 3]]))).toBe(
      '<g1><g2>a</g2><g3>b</g3></g1>',
    );
  });

  it('aceita exatamente o limite de wrappers e de profundidade', () => {
    const eight = layoutOf(
      ...Array.from({ length: MAX_INLINE_WRAPPERS }, (_, i): [string, number[]] => [
        `w${i}`,
        [i + 1],
      ]),
    );
    expect(encodeMarkers(eight)).not.toBeNull();
    const deep = layoutOf(['a', [1, 2, 3]]);
    expect(MAX_INLINE_DEPTH).toBe(3);
    expect(encodeMarkers(deep)).toBe('<g1><g2><g3>a</g3></g2></g1>');
  });

  it('devolve null acima do limite de wrappers ou de profundidade', () => {
    const nine = layoutOf(
      ...Array.from({ length: MAX_INLINE_WRAPPERS + 1 }, (_, i): [string, number[]] => [
        `w${i}`,
        [i + 1],
      ]),
    );
    expect(encodeMarkers(nine)).toBeNull();
    expect(encodeMarkers(layoutOf(['a', [1, 2, 3, 4]]))).toBeNull();
  });

  it('devolve null para layout sem wrapper', () => {
    expect(encodeMarkers(layoutOf(['plain text', []]))).toBeNull();
  });

  it.each<[string, InlineLayout]>([
    ['sem runs', { runs: [] }],
    ['id que não começa em 1', layoutOf(['a', [2]])],
    ['ids fora da ordem de abertura', layoutOf(['a', [2]], ['b', [1]])],
    ['wrapper reaberto (não contíguo)', layoutOf(['a', [1]], ['b', []], ['c', [1]])],
    ['wrapper com pai diferente', layoutOf(['a', [1, 2]], ['b', [2]])],
    ['runs vizinhos com o mesmo path', layoutOf(['a', [1]], ['b', [1]])],
    ['id zero', layoutOf(['a', [0]])],
    ['id não inteiro', layoutOf(['a', [1.5]])],
    ['id repetido no path', layoutOf(['a', [1, 1]])],
  ])('devolve null para layout inválido: %s', (_, layout) => {
    expect(encodeMarkers(layout)).toBeNull();
  });

  it('devolve null para entradas anômalas sem lançar', () => {
    const bad = [null, {}, { runs: 'x' }, { runs: [null] }, { runs: [{ text: 1, path: [] }] }];
    for (const layout of bad) {
      expect(encodeMarkers(layout as unknown as InlineLayout)).toBeNull();
    }
  });

  it.each([
    'tag <g1> inside',
    'tag </G2> inside',
    'bare <g> tag',
    'spaced < g 3 > tag',
    'self-closing <g1/> tag',
  ])('devolve null quando o texto colide com a sintaxe de marcador: %s', (collidingText) => {
    const layout = layoutOf([collidingText, []], ['word', [1]]);
    expect(encodeMarkers(layout)).toBeNull();
  });

  it('não colide com colchetes nem com outras tags', () => {
    const layout = layoutOf(['a footnote [1], ⟦x⟧ and <b> or <gx> ', []], ['word', [1]]);
    expect(encodeMarkers(layout)).toBe('a footnote [1], ⟦x⟧ and <b> or <gx> <g1>word</g1>');
  });
});

describe('validateInlineLayout', () => {
  it('informa wrappers e profundidade', () => {
    expect(validateInlineLayout(NESTED)).toEqual({ ok: true, wrappers: 2, depth: 2 });
  });

  it.each<[string, InlineLayout]>([
    ['invalid_layout', { runs: [] }],
    ['adjacent_same_path', layoutOf(['a', []], ['b', []])],
    ['non_canonical_ids', layoutOf(['a', [1]], ['b', []], ['c', [1]])],
    ['too_deep', layoutOf(['a', [1, 2, 3, 4]])],
    [
      'too_many_wrappers',
      layoutOf(...Array.from({ length: 9 }, (_, i): [string, number[]] => ['w', [i + 1]])),
    ],
    ['no_wrappers', layoutOf(['a', []])],
  ])('devolve %s', (error, layout) => {
    expect(validateInlineLayout(layout)).toEqual({ ok: false, error });
  });

  it('não verifica colisão', () => {
    expect(validateInlineLayout(layoutOf(['<g1> ', []], ['x', [1]])).ok).toBe(true);
  });
});

describe('countMarkerSyntax', () => {
  it('conta marcadores exatos e malformados', () => {
    expect(countMarkerSyntax('<g1>a</g1> < g2 > <G3/>')).toBe(4);
    expect(countMarkerSyntax('[1] [/1] ⟦1⟧ <b>')).toBe(0);
    expect(countMarkerSyntax(undefined as unknown as string)).toBe(0);
  });
});

describe('decodeMarkers', () => {
  it('alinha os runs quando a tradução move texto para fora do marcador', () => {
    const result = decodeMarkers('a pedra <g1>vermelha</g1>', RED_STONE);
    expect(result).toEqual({ ok: true, texts: ['a pedra ', 'vermelha', ''] });
  });

  it('aceita texto externo deslocado entre intervalos', () => {
    const result = decodeMarkers('A x B C <g1>x</g1> <g2>y</g2>', TWO_SPANS);
    expect(result).toEqual({ ok: true, texts: ['A x B C ', 'x', ' ', 'y', ''] });
  });

  it('preserva espaços internos junto aos marcadores', () => {
    const result = decodeMarkers('a pedra <g1> vermelha </g1>', RED_STONE);
    expect(result).toEqual({ ok: true, texts: ['a pedra ', ' vermelha ', ''] });
  });

  it('troca as bordas externas da saída pelas do texto codificado', () => {
    const layout = layoutOf(['  Lead ', []], ['red', [1]], [' tail\n', []]);
    const result = decodeMarkers('\n\nInício <g1>vermelho</g1> fim   \n', layout);
    expect(result).toEqual({ ok: true, texts: ['  Início ', 'vermelho', ' fim\n'] });
  });

  it('descarta espaço em intervalo sem run', () => {
    const result = decodeMarkers('  <g1>Vermelho</g1> <g2>Azul</g2> céu', ADJACENT_AT_START);
    expect(result).toEqual({ ok: true, texts: ['Vermelho', 'Azul', ' céu'] });
  });

  it('decodifica a estrutura aninhada', () => {
    expect(decodeMarkers('Ela <g1>pegou a <g2>lâmina</g2> de volta</g1>.', NESTED)).toEqual({
      ok: true,
      texts: ['Ela ', 'pegou a ', 'lâmina', ' de volta', '.'],
    });
  });

  it('mantém nota de rodapé entre colchetes como texto', () => {
    const layout = layoutOf(['the ', []], ['Gate', [1]], ['[1].', []]);
    expect(decodeMarkers('o <g1>Portão</g1>[1].', layout)).toEqual({
      ok: true,
      texts: ['o ', 'Portão', '[1].'],
    });
  });

  it.each<[string, string, InlineLayout]>([
    ['missing', 'a pedra vermelha', RED_STONE],
    ['missing', 'a pedra <g1>vermelha', RED_STONE],
    ['unknown', 'a <g1>pedra</g1> <g3>x</g3>', RED_STONE],
    ['duplicate', '<g1>a</g1> pedra <g1>b</g1>', RED_STONE],
    ['duplicate', 'a pedra <g1>vermelha</g1></g1>', RED_STONE],
    ['order', 'A <g2>y</g2> B <g1>x</g1> C', TWO_SPANS],
    ['nesting', 'Ela <g1>pegou <g2>a</g1> lâmina</g2>.', NESTED],
    ['nesting', 'a pedra </g1>vermelha<g1>', RED_STONE],
    ['nesting', 'Ela <g1>pegou</g1> a <g2>lâmina</g2>.', NESTED],
    ['nesting', 'A <g1>x B <g2>y</g2></g1> C', TWO_SPANS],
    ['empty_run', 'a pedra <g1></g1>', RED_STONE],
    ['empty_run', 'a pedra <g1>  </g1>', RED_STONE],
    ['empty_run', 'Ela <g1><g2>lâmina</g2></g1> de volta.', NESTED],
    ['collision', 'a pedra <g1>vermelha</g1> < g1>', RED_STONE],
    ['collision', 'a pedra <g1>vermelha<g1/>', RED_STONE],
    ['collision', 'a pedra <G1>vermelha</g1>', RED_STONE],
    ['collision', 'a pedra <g1>vermelha</g01>', RED_STONE],
    ['orphan_text', 'O <g1>Vermelho</g1><g2>Azul</g2> céu', ADJACENT_AT_START],
    ['orphan_text', '<g1>Vermelho</g1> e <g2>Azul</g2> céu', ADJACENT_AT_START],
  ])('devolve %s para %j', (error, output, layout) => {
    expect(decodeMarkers(output, layout)).toEqual({ ok: false, error });
  });

  it('permite que um run externo com letra fique vazio', () => {
    const result = decodeMarkers('<g1>Vermelha</g1>, a pedra', RED_STONE);
    expect(result).toEqual({ ok: true, texts: ['', 'Vermelha', ', a pedra'] });
  });

  it('não exige letra em run que não tinha letra', () => {
    const layout = layoutOf(['Wait', []], ['...', [1]]);
    expect(decodeMarkers('Espere<g1> </g1>', layout)).toEqual({ ok: true, texts: ['Espere', ' '] });
  });

  it('devolve invalid_layout quando o layout não é codificável', () => {
    expect(decodeMarkers('texto', layoutOf(['texto', []]))).toEqual({
      ok: false,
      error: 'invalid_layout',
    });
    const colliding = layoutOf(['note <g1> ', []], ['x', [1]]);
    expect(decodeMarkers('nota <g1> <g1>x</g1>', colliding)).toEqual({
      ok: false,
      error: 'invalid_layout',
    });
  });

  it('devolve missing para saída que não é string', () => {
    expect(decodeMarkers(undefined as unknown as string, RED_STONE)).toEqual({
      ok: false,
      error: 'missing',
    });
  });
});

/** PRNG determinístico (mulberry32) para a propriedade de ida e volta. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'stone',
  'café',
  'ação',
  'naïve',
  'Über',
  'coração',
  '🐉',
  '火の鳥',
  '龍',
  '한국어',
  '“olá”',
  '—',
  'ñandú',
  'x²',
  '…',
  '👩‍🚀',
];

function randomLayout(rand: () => number): InlineLayout {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const randomText = (): string => {
    const words = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(WORDS));
    return pick(['', ' ', '  ']) + words.join(' ') + pick(['', ' ', '\n']);
  };

  for (;;) {
    const budget = 1 + Math.floor(rand() * MAX_INLINE_WRAPPERS);
    const runs: InlineRun[] = [];
    let nextId = 1;
    const emit = (path: number[]): void => {
      const count = 1 + Math.floor(rand() * 3);
      let lastWasText = false;
      for (let i = 0; i < count; i += 1) {
        const canWrap = path.length < MAX_INLINE_DEPTH && nextId <= budget;
        if (canWrap && (lastWasText || rand() < 0.5)) {
          const id = nextId;
          nextId += 1;
          emit([...path, id]);
          lastWasText = false;
        } else if (!lastWasText) {
          runs.push({ text: randomText(), path });
          lastWasText = true;
        }
      }
    };
    emit([]);
    if (nextId > 1) return { runs };
  }
}

describe('propriedade de ida e volta', () => {
  const rand = mulberry32(0x1e51a);
  const layouts = Array.from({ length: 150 }, () => randomLayout(rand));

  it('gera layouts válidos e variados dentro dos limites', () => {
    const validations = layouts.map(validateInlineLayout);
    expect(validations.every((validation) => validation.ok)).toBe(true);
    const wrappers = new Set(validations.map((v) => (v.ok ? v.wrappers : 0)));
    const depths = new Set(validations.map((v) => (v.ok ? v.depth : 0)));
    expect(wrappers.has(1) && wrappers.has(MAX_INLINE_WRAPPERS)).toBe(true);
    expect(depths.has(1) && depths.has(MAX_INLINE_DEPTH)).toBe(true);
  });

  it('decode(encode(layout)) devolve os textos originais', () => {
    for (const layout of layouts) {
      const encoded = encodeMarkers(layout);
      expect(encoded).not.toBeNull();
      expect(decodeMarkers(encoded as string, layout)).toEqual({
        ok: true,
        texts: texts(layout),
      });
      // Espaço extra nas bordas externas da resposta não altera o resultado.
      expect(decodeMarkers(`\n ${encoded as string} \n\n`, layout)).toEqual({
        ok: true,
        texts: texts(layout),
      });
    }
  });
});

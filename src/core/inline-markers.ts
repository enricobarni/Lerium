/**
 * Codec de marcadores inline (ADR-003, opção 3 híbrida). Módulo puro: não
 * referencia DOM, `chrome` nem `console`.
 *
 * Formato único `<g1>…</g1>`: no experimento com `translategemma:4b` (10
 * fixtures × 3 execuções) teve a maior taxa de decode válido (73%, contra 67%
 * de `[1]…[/1]` e 63% de `⟦1⟧…⟦/1⟧`); os outros formatos saíram do código.
 *
 * Um bloco com markup inline (`<em>`, `<strong>`, `<a>`...) é descrito como
 * uma sequência de *runs* de texto. Cada run carrega o `path` dos wrappers
 * inline que o envolvem, do mais externo ao mais interno. `encodeMarkers`
 * concatena os runs com marcadores numerados para o modelo traduzir o bloco
 * inteiro; `decodeMarkers` valida a saída do modelo e devolve um texto por
 * run, para aplicar via `nodeValue` (nunca como HTML).
 *
 * Layout canônico (qualquer desvio torna o layout inválido):
 * - ids são inteiros 1-based atribuídos na ordem de abertura (1, 2, 3...);
 * - um wrapper cobre runs contíguos: depois de fechado, não reabre;
 * - runs vizinhos têm `path` diferente (senão não haveria fronteira entre eles);
 * - no máximo `MAX_INLINE_WRAPPERS` wrappers e `MAX_INLINE_DEPTH` níveis (hoje
 *   1: wrappers lado a lado, sem aninhamento);
 * - pelo menos um wrapper (sem wrapper não há o que marcar).
 *
 * Semântica dos runs na decodificação: o DOM não reordena nós, então o que
 * importa é a sequência de marcadores. A saída é válida se abre e fecha os
 * mesmos marcadores, na mesma ordem e com o mesmo aninhamento da entrada. O
 * texto de cada intervalo entre marcadores vai para o run que ocupava esse
 * intervalo, mesmo que o modelo tenha deslocado palavras de um lado para o
 * outro de um marcador (ex.: "the <g1>red</g1> stone" →
 * "a pedra <g1>vermelha</g1>": o run externo inicial recebe "a pedra ", o
 * marcado "vermelha" e o externo final "").
 *
 * `empty_run` vale só para runs dentro de wrapper: se um run marcado que tinha
 * letra volta vazio ou só com espaço, o elemento inline ficaria vazio na
 * página. Um run externo pode ficar vazio, porque a tradução desloca palavras.
 *
 * Deslocar uma palavra é aceito; omitir ou mover frases inteiras, não. Como o
 * texto de cada intervalo vai para o nó que o ocupava, uma saída que joga tudo
 * para dentro do marcador (ou apaga o texto de fora) trocaria o conteúdo da
 * página de lugar. As heurísticas contam letras (`\p{L}`), não caracteres:
 * - `lost_text`: os runs externos tinham pelo menos `LOST_TEXT_MIN_OUTER`
 *   letras e voltaram sem nenhuma; ou, com pelo menos `RATIO_MIN_LETTERS`
 *   letras na entrada, a saída tem menos de `MIN_LETTER_RATIO` ou mais de
 *   `MAX_LETTER_RATIO` vezes as letras da entrada;
 * - `run_growth`: com pelo menos `GROWTH_MIN_LETTERS` letras na entrada, um
 *   run marcado cuja fração das letras da saída passa de
 *   `GROWTH_FACTOR × fração na entrada + GROWTH_SLACK`.
 * Os limites são conservadores: um destino CJK (ja, ko, zh-CN) usa bem menos
 * letras por significado que um latino (um ideograma ≈ uma palavra), e a
 * razão inferior de 0,25 foi escolhida para não recusar essas traduções; a
 * folga absoluta de `run_growth` deixa passar adjetivo deslocado e nome
 * próprio que cresce na tradução. Texto curto fica fora das heurísticas.
 *
 * Intervalos sem run (entre dois marcadores colados, ou antes do primeiro
 * marcador quando o primeiro run já é marcado) não têm nó de destino: espaço
 * neles é descartado; qualquer outro texto falha com `orphan_text`.
 *
 * Espaços: o interior de cada intervalo é devolvido literalmente, sem trim
 * (espaço junto a um marcador é parte do texto do run). Só as bordas externas
 * da saída inteira são normalizadas: o espaço inicial e final que o modelo
 * produzir é trocado pelo espaço inicial e final do texto codificado. Assim
 * uma quebra de linha extra no fim da resposta não vira texto do último run.
 *
 * Colisão: não há escape. Se um run já contém sintaxe de marcador (inclusive
 * malformada, sem diferenciar maiúsculas: `<g>`, `</G2>`, `< g1 >`),
 * `encodeMarkers` devolve `null` e o chamador usa outra estratégia (nó a nó).
 * Na saída, qualquer sintaxe de marcador que não seja exata (ex.: `< g1>`,
 * `<G1>`, `<g1/>`) é `collision`; por isso nenhum marcador vaza para `texts`.
 * Colchetes como a nota de rodapé "[1]" não são sintaxe deste formato.
 */

export interface InlineRun {
  readonly text: string;
  /** Ids dos wrappers inline, do mais externo ao mais interno; `[]` = fora de wrapper. */
  readonly path: readonly number[];
}

export interface InlineLayout {
  readonly runs: readonly InlineRun[];
}

export const MAX_INLINE_WRAPPERS = 8;

/**
 * Só wrappers lado a lado, sem aninhamento. No experimento da ADR-003
 * (`translategemma:4b`, 3 execuções) a fixture com `<strong>` dentro de `<a>`
 * não decodificou em nenhuma: 0/3 em `<g1>` e também 0/3 nos demais formatos.
 * Layout com profundidade maior é recusado (`too_deep`, `encodeMarkers` dá
 * `null`) e o segmento segue nó a nó.
 */
export const MAX_INLINE_DEPTH = 1;

export type InlineLayoutError =
  | 'invalid_layout'
  | 'adjacent_same_path'
  | 'non_canonical_ids'
  | 'too_deep'
  | 'too_many_wrappers'
  | 'no_wrappers';

/**
 * Prioridade quando há mais de um problema: `invalid_layout` → `collision` →
 * `unknown` → `duplicate` → `missing` → `nesting` (marcadores cruzados) →
 * `order` → `nesting` (estrutura diferente da original) → `orphan_text` →
 * `empty_run` → `lost_text` (runs externos esvaziados, depois razão global)
 * → `run_growth`.
 *
 * `invalid_layout`: o layout não é codificável (`encodeMarkers` daria `null`).
 * `orphan_text`: texto não branco num intervalo sem run de destino.
 * `lost_text` e `run_growth`: texto omitido ou deslocado entre runs (ver o
 * cabeçalho do módulo).
 */
export type DecodeError =
  | 'missing'
  | 'unknown'
  | 'duplicate'
  | 'order'
  | 'nesting'
  | 'empty_run'
  | 'collision'
  | 'orphan_text'
  | 'lost_text'
  | 'run_growth'
  | 'invalid_layout';

/** Letras mínimas nos runs externos para exigir que alguma volte (`lost_text`). */
export const LOST_TEXT_MIN_OUTER = 12;
/** Letras mínimas na entrada para aplicar a razão global (`lost_text`). */
export const RATIO_MIN_LETTERS = 40;
/** Razão mínima letras da saída / letras da entrada (cabe CJK: ver o cabeçalho). */
export const MIN_LETTER_RATIO = 0.25;
/** Razão máxima letras da saída / letras da entrada. */
export const MAX_LETTER_RATIO = 4;
/** Letras mínimas na entrada para aplicar `run_growth`. */
export const GROWTH_MIN_LETTERS = 20;
export const GROWTH_FACTOR = 3;
export const GROWTH_SLACK = 0.15;

export type DecodeResult = { ok: true; texts: string[] } | { ok: false; error: DecodeError };

const openMarker = (id: number): string => `<g${id}>`;
const closeMarker = (id: number): string => `</g${id}>`;
/**
 * Qualquer coisa parecida com marcador (exata ou malformada). Global.
 *
 * Linear de propósito: cada quantificador cobre uma classe que não contém o
 * caractere seguinte (`g` depois de `[\s/]*`, `>` depois de `[\s\d/]*`), então
 * não há backtracking. A forma anterior (`<\s*\/?\s*g\s*\d*\s*\/?\s*>`) tinha
 * `\s*` adjacentes e custo polinomial (2000 espaços → dezenas de segundos). É
 * mais permissiva que a sintaxe real; `STRICT_MARKER` decide o que é exato.
 */
const LOOSE_MARKER = /<[\s/]*g[\s\d/]*>/giu;
/** Marcador exato, ancorado: grupo 1 = `/` de fechamento, grupo 2 = id. */
const STRICT_MARKER = /^<(\/?)g([1-9]\d{0,2})>$/u;

interface MarkerEvent {
  readonly close: boolean;
  readonly id: number;
}

interface LayoutPlan {
  readonly events: readonly MarkerEvent[];
  /** Para cada run, o índice do intervalo (entre eventos) que ele ocupa. */
  readonly runSlots: readonly number[];
  readonly wrappers: number;
  readonly depth: number;
}

type PlanResult = { ok: true; plan: LayoutPlan } | { ok: false; error: InlineLayoutError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const HAS_LETTER = /\p{L}/u;
const LETTERS = /\p{L}/gu;

/** Nº de letras (`\p{L}`); linear, uma classe sem quantificador. */
const countLetters = (text: string): number => text.match(LETTERS)?.length ?? 0;

/** Lê o layout uma vez, validando forma e estrutura. Nunca lança. */
function planLayout(layout: unknown): PlanResult {
  const fail = (error: InlineLayoutError): PlanResult => ({ ok: false, error });
  try {
    if (!isRecord(layout) || !Array.isArray(layout.runs) || layout.runs.length === 0) {
      return fail('invalid_layout');
    }
    const runs: unknown[] = layout.runs;
    const events: MarkerEvent[] = [];
    const runSlots: number[] = [];
    let previous: readonly number[] = [];
    let nextId = 1;
    let depth = 0;

    for (const [index, run] of runs.entries()) {
      if (!isRecord(run) || typeof run.text !== 'string' || !Array.isArray(run.path)) {
        return fail('invalid_layout');
      }
      const path: unknown[] = run.path;
      if (!path.every(isPositiveInteger)) return fail('invalid_layout');
      if (new Set(path).size !== path.length) return fail('invalid_layout');
      if (path.length > MAX_INLINE_DEPTH) return fail('too_deep');
      const current = path as number[];

      let common = 0;
      while (
        common < previous.length &&
        common < current.length &&
        previous[common] === current[common]
      ) {
        common += 1;
      }
      if (index > 0 && common === previous.length && common === current.length) {
        return fail('adjacent_same_path');
      }
      for (let level = previous.length - 1; level >= common; level -= 1) {
        events.push({ close: true, id: previous[level] as number });
      }
      for (let level = common; level < current.length; level += 1) {
        // Ids canônicos: um id reaberto ou fora de sequência é sempre < ou > nextId.
        if (current[level] !== nextId) return fail('non_canonical_ids');
        events.push({ close: false, id: nextId });
        nextId += 1;
      }
      runSlots.push(events.length);
      depth = Math.max(depth, current.length);
      previous = current;
    }
    for (let level = previous.length - 1; level >= 0; level -= 1) {
      events.push({ close: true, id: previous[level] as number });
    }

    const wrappers = nextId - 1;
    if (wrappers === 0) return fail('no_wrappers');
    if (wrappers > MAX_INLINE_WRAPPERS) return fail('too_many_wrappers');
    return { ok: true, plan: { events, runSlots, wrappers, depth } };
  } catch {
    // Getters anômalos num layout vindo de outro contexto.
    return fail('invalid_layout');
  }
}

export type InlineLayoutValidation =
  { ok: true; wrappers: number; depth: number } | { ok: false; error: InlineLayoutError };

/** Valida a estrutura do layout (não verifica colisão com marcadores). */
export function validateInlineLayout(layout: InlineLayout): InlineLayoutValidation {
  const planned = planLayout(layout);
  if (!planned.ok) return planned;
  return { ok: true, wrappers: planned.plan.wrappers, depth: planned.plan.depth };
}

/** Nº de trechos com sintaxe de marcador (exata ou malformada) em `text`. */
export function countMarkerSyntax(text: string): number {
  if (typeof text !== 'string') return 0;
  return [...text.matchAll(LOOSE_MARKER)].length;
}

function renderEvent(event: MarkerEvent): string {
  return event.close ? closeMarker(event.id) : openMarker(event.id);
}

/** Texto codificado; `null` se o layout for inválido ou algum run colidir. */
function encodeWithPlan(layout: InlineLayout): string | null {
  const planned = planLayout(layout);
  if (!planned.ok) return null;
  const { events, runSlots } = planned.plan;
  const texts = layout.runs.map((run) => run.text);
  if (texts.some((text) => countMarkerSyntax(text) > 0)) return null;

  const intervals = Array.from({ length: events.length + 1 }, () => '');
  runSlots.forEach((slot, index) => {
    intervals[slot] = texts[index] as string;
  });
  let encoded = intervals[0] as string;
  events.forEach((event, index) => {
    encoded += renderEvent(event) + (intervals[index + 1] as string);
  });
  return encoded;
}

/**
 * Concatena os runs com marcadores `<gN>…</gN>`. Devolve `null` se o layout
 * for inválido (ver cabeçalho), não tiver wrapper, exceder os limites ou se
 * algum run já contiver sintaxe de marcador (colisão; não há escape).
 */
export function encodeMarkers(layout: InlineLayout): string | null {
  return encodeWithPlan(layout);
}

// Sem regex: `/\s*$/u` testa cada posição inicial e é quadrática numa
// sequência longa de espaços seguida de não-espaço. `trimStart`/`trimEnd`
// usam o mesmo conjunto de espaços que `\s` e são lineares.
const leadingSpace = (text: string): string => text.slice(0, text.length - text.trimStart().length);
const trailingSpace = (text: string): string => text.slice(text.trimEnd().length);

interface Token {
  readonly start: number;
  readonly end: number;
  readonly close: boolean;
  readonly id: number;
}

/**
 * Valida a saída do modelo contra o layout e devolve um texto por run, na
 * ordem de `layout.runs`. Ver o cabeçalho para a semântica dos intervalos,
 * dos espaços e da colisão, e `DecodeError` para a prioridade dos erros.
 */
export function decodeMarkers(output: string, layout: InlineLayout): DecodeResult {
  const fail = (error: DecodeError): DecodeResult => ({ ok: false, error });
  const encoded = encodeWithPlan(layout);
  const planned = planLayout(layout);
  if (encoded === null || !planned.ok) return fail('invalid_layout');
  const { events, runSlots, wrappers } = planned.plan;
  if (typeof output !== 'string') return fail('missing');

  // Bordas externas: trocadas pelas do texto codificado.
  const lead = leadingSpace(encoded);
  const trail = trailingSpace(encoded);
  const text = lead + output.trim() + trail;

  const tokens: Token[] = [];
  for (const match of text.matchAll(LOOSE_MARKER)) {
    const exact = STRICT_MARKER.exec(match[0]);
    if (exact === null) return fail('collision');
    const start = match.index;
    tokens.push({
      start,
      end: start + match[0].length,
      close: exact[1] === '/',
      id: Number(exact[2]),
    });
  }

  if (tokens.some((token) => token.id > wrappers)) return fail('unknown');

  const opens = new Array<number>(wrappers + 1).fill(0);
  const closes = new Array<number>(wrappers + 1).fill(0);
  for (const token of tokens) {
    const counter = token.close ? closes : opens;
    counter[token.id] = (counter[token.id] as number) + 1;
  }
  for (let id = 1; id <= wrappers; id += 1) {
    if ((opens[id] as number) > 1 || (closes[id] as number) > 1) return fail('duplicate');
  }
  for (let id = 1; id <= wrappers; id += 1) {
    if (opens[id] === 0 || closes[id] === 0) return fail('missing');
  }

  const stack: number[] = [];
  for (const token of tokens) {
    if (!token.close) stack.push(token.id);
    else if (stack.pop() !== token.id) return fail('nesting');
  }

  const openOrder = tokens.filter((token) => !token.close).map((token) => token.id);
  if (openOrder.some((id, index) => id !== index + 1)) return fail('order');

  // Mesma ordem de abertura, mas fechamentos em outro lugar: aninhamento diferente.
  const sameEvents = events.every(
    (event, index) => event.close === tokens[index]?.close && event.id === tokens[index]?.id,
  );
  if (!sameEvents) return fail('nesting');

  const intervals: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    intervals.push(text.slice(cursor, token.start));
    cursor = token.end;
  }
  intervals.push(text.slice(cursor));

  const occupied = new Set(runSlots);
  if (intervals.some((interval, slot) => !occupied.has(slot) && interval.trim() !== '')) {
    return fail('orphan_text');
  }

  const texts = runSlots.map((slot) => intervals[slot] as string);
  const lostLetters = layout.runs.some(
    (run, index) =>
      run.path.length > 0 && HAS_LETTER.test(run.text) && (texts[index] as string).trim() === '',
  );
  if (lostLetters) return fail('empty_run');

  const lettersIn = layout.runs.map((run) => countLetters(run.text));
  const lettersOut = texts.map(countLetters);
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
  const isOuter = (index: number): boolean => layout.runs[index]?.path.length === 0;
  const outerIn = sum(lettersIn.filter((_, index) => isOuter(index)));
  const outerOut = sum(lettersOut.filter((_, index) => isOuter(index)));
  if (outerIn >= LOST_TEXT_MIN_OUTER && outerOut === 0) return fail('lost_text');
  const inL = sum(lettersIn);
  const outL = sum(lettersOut);
  if (
    inL >= RATIO_MIN_LETTERS &&
    (outL < MIN_LETTER_RATIO * inL || outL > MAX_LETTER_RATIO * inL)
  ) {
    return fail('lost_text');
  }

  if (inL >= GROWTH_MIN_LETTERS && outL > 0) {
    const grew = lettersIn.some((letters, index) => {
      if (isOuter(index)) return false;
      const fractionIn = letters / inL;
      const fractionOut = (lettersOut[index] as number) / outL;
      return fractionOut > GROWTH_FACTOR * fractionIn + GROWTH_SLACK;
    });
    if (grew) return fail('run_growth');
  }
  return { ok: true, texts };
}

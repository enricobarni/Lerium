/**
 * Aplicação da tradução no DOM e restauração do original (Fase 4, RF06,
 * ADR-003).
 *
 * Fluxo, por segmento: `plan` decide a estratégia e devolve as unidades de
 * texto para o modelo; quem executa o job traduz as unidades e chama `apply`
 * com os resultados. O texto entra no DOM só por `Text.data` (nunca como
 * HTML), e todo nó escrito fica num registro que permite `restore` e
 * `reapply`. Sem `chrome`, sem mensagens, sem logs e sem estado de módulo:
 * cada `createPageApplier()` é um registro independente (um por documento).
 *
 * Estratégias (`UnitKind`):
 * - `plain`: segmento sem markup inline e com um único nó com conteúdo; uma
 *   unidade com `segment.text`. A tradução, sem as bordas de espaço, vai para
 *   esse nó entre o espaço inicial e final originais; nós só de espaço ficam
 *   intocados.
 * - `markers`: markup inline de um nível; uma unidade com o texto codificado
 *   (`encodeMarkers`). O texto de cada run decodificado vai ao único nó com
 *   conteúdo do run (ou ao primeiro nó, se o run é só espaço). Run de um nó:
 *   escrita literal. Run de vários nós (ex.: `bold<!--c--> `): o alvo recebe
 *   o texto sem bordas entre as bordas originais dele, e os outros nós (só de
 *   espaço) ficam como estão; escrever o texto do run inteiro no alvo
 *   duplicaria o espaço dos vizinhos. Um run de vários nós só de espaço cujo
 *   texto volta só de espaço não é escrito; se a tradução pôs palavras nele,
 *   elas vão para o primeiro nó, também entre as bordas originais.
 *   Marcadores inválidos na saída → `markers_invalid` com um plano `per_node`
 *   de fallback para o mesmo segmento.
 * - `per_node`: uma unidade por nó com letra, com o texto do nó colapsado. É
 *   o caminho quando há vários nós com conteúdo sem layout útil, quando os
 *   limites inline estouram, quando `encodeMarkers` recusa o layout, quando
 *   um run tem mais de um nó com conteúdo e como fallback dos marcadores.
 *   Nunca se concentra a tradução no primeiro nó (PLAN.md §2.2, risco 6).
 *
 * Atomicidade por segmento: ou todos os nós do segmento recebem a tradução,
 * ou nenhum. Antes de escrever, todos os nós do segmento precisam continuar
 * conectados, com o mesmo `data` e o mesmo `parentNode` capturados no `plan`,
 * e fora de área excluída (`isExcludedElement` do pai até o bloco) ou
 * editável (`isInEditableContext`); senão, `node_changed`. No
 * `per_node`, uma unidade sem resultado (`translation_failed`) ou implausível
 * (`implausible_output`) deixa o segmento inteiro no original: aplicar só
 * parte dos nós misturaria idiomas dentro de uma frase. As escritas são
 * síncronas, sem `await` entre elas.
 *
 * Plausibilidade: tradução vazia ou com razão de letras fora de
 * `checkLetterRatio` é `implausible_output` (no `markers`, o codec já aplica
 * a mesma razão e o erro vira `markers_invalid`).
 *
 * Restauração: o registro guarda, por nó, o `original` e o último `applied`.
 * O `original` é gravado na primeira escrita e regravado quando uma nova
 * escrita encontra no nó um texto diferente do aplicado (o site o trocou).
 * `restore` só escreve o original em nós cujo `data` ainda é o aplicado;
 * `reapply` só escreve o aplicado em nós cujo `data` ainda é o original. Um
 * nó que o site alterou depois da escrita, ou que está num contexto editável
 * no momento, não é tocado e conta como pulado. Nós desconectados contam como
 * pulados e saem do registro. Um segundo `restore` seguido conta tudo como
 * pulado (os nós já têm o original, não o aplicado); idem para `reapply`.
 */

import { decodeMarkers, encodeMarkers, type InlineLayout } from '../core/inline-markers';
import { checkLetterRatio } from '../core/letter-ratio';
import { isExcludedElement, isInEditableContext } from './dom-collector';
import { INLINE_LIMITS_EXCEEDED, inlineLayoutOf } from './inline-layout';
import { MAX_SEGMENT_CHARS, type TranslationSegment } from './segmenter';

export type UnitKind = 'plain' | 'markers' | 'per_node';

/**
 * Texto a enviar ao modelo; `unitId` identifica o resultado no `apply`. O id
 * carrega o token do plano que o gerou (`seg-0#text@7`): um resultado de um
 * plano substituído, ou um id forjado, não casa com nenhuma unidade e o
 * segmento fica no original (`translation_failed`).
 */
export interface TranslationUnit {
  readonly unitId: string;
  readonly text: string;
}

export interface SegmentPlan {
  readonly segmentId: string;
  readonly kind: UnitKind;
  readonly units: readonly TranslationUnit[];
}

/** Segmento maior que `MAX_SEGMENT_CHARS`: fica no original, sem unidades. */
export interface SkippedSegment {
  readonly segmentId: string;
  readonly skipped: 'segment_too_long';
}

/**
 * Por que um segmento ficou no original. `unknown_segment`: `apply` sem
 * `plan` pendente para o id (nunca planejado ou já aplicado).
 */
export type SkipReason =
  | 'segment_too_long'
  | 'unknown_segment'
  | 'node_changed'
  | 'implausible_output'
  | 'markers_invalid'
  | 'translation_failed';

export type ApplyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SkipReason; readonly fallback?: SegmentPlan };

export interface PageApplier {
  /** Planeja o segmento e substitui um plano pendente com o mesmo id. */
  plan(segment: TranslationSegment): SegmentPlan | SkippedSegment;
  /**
   * Aplica os resultados (`unitId` → tradução, ou `null` se falhou) do plano
   * pendente. Consome o plano, exceto quando devolve `fallback`: aí o plano
   * pendente passa a ser o fallback, com o mesmo snapshot do `plan` original.
   */
  apply(segmentId: string, results: ReadonlyMap<string, string | null>): ApplyResult;
  restore(): { restored: number; skipped: number };
  reapply(): { reapplied: number; skipped: number };
  /** Esquece o registro e os planos pendentes, sem escrever no DOM. */
  clear(): void;
}

/** Espaço ASCII, o mesmo que o segmentador colapsa; U+00A0 conta como conteúdo. */
const HAS_CONTENT = /[^ \t\n\r\f]/;
const ASCII_WHITESPACE_RUN = /[ \t\n\r\f]+/g;
const LETTER = /\p{L}/u;

function isAsciiSpace(code: number): boolean {
  // ' ', '\t', '\n', '\f', '\r'
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
}

// Laços em vez de regex: `/[ \t\n\r\f]*$/` é quadrática numa sequência
// longa de espaços seguida de não-espaço.
function leadingSpaceEnd(text: string): number {
  let index = 0;
  while (index < text.length && isAsciiSpace(text.charCodeAt(index))) index += 1;
  return index;
}

function trailingSpaceStart(text: string): number {
  let index = text.length;
  while (index > 0 && isAsciiSpace(text.charCodeAt(index - 1))) index -= 1;
  return index;
}

/** Apara só espaço ASCII nas pontas; NBSP fica. */
function trimAscii(text: string): string {
  const start = leadingSpaceEnd(text);
  return text.slice(start, Math.max(start, trailingSpaceStart(text)));
}

/** Mesma normalização do segmentador, para um nó. */
function collapse(text: string): string {
  return trimAscii(text.replace(ASCII_WHITESPACE_RUN, ' '));
}

/** Tradução sem bordas entre o espaço inicial e final do texto original. */
function withOriginalEdges(original: string, translation: string): string {
  const lead = original.slice(0, leadingSpaceEnd(original));
  const trail = original.slice(Math.max(lead.length, trailingSpaceStart(original)));
  return lead + translation + trail;
}

interface NodeUnit {
  readonly unitId: string;
  readonly source: string;
  readonly node: Text;
  /** `data` do nó no `plan`. */
  readonly original: string;
}

type Strategy =
  | { readonly kind: 'plain'; readonly unit: NodeUnit }
  | {
      readonly kind: 'markers';
      readonly unitId: string;
      readonly layout: InlineLayout;
      /** Destino de cada run, na ordem de `layout.runs`. */
      readonly targets: readonly RunTarget[];
    }
  | { readonly kind: 'per_node'; readonly units: readonly NodeUnit[] };

interface RunTarget {
  readonly node: Text;
  /** `data` do nó no `plan`. */
  readonly original: string;
  /** Run de um nó só: o texto decodificado vai literalmente. */
  readonly literal: boolean;
}

interface PendingPlan {
  readonly block: Element;
  readonly nodes: readonly Text[];
  /** `data` de cada nó de `nodes` no momento do `plan`. */
  readonly snapshot: readonly string[];
  /** `parentNode` de cada nó de `nodes` no momento do `plan`. */
  readonly parents: readonly (ParentNode | null)[];
  readonly plan: SegmentPlan;
  readonly strategy: Strategy;
}

type Planned = { readonly plan: SegmentPlan; readonly strategy: Strategy };

interface Write {
  readonly node: Text;
  readonly value: string;
}

type BuildResult =
  | { readonly ok: true; readonly writes: readonly Write[] }
  | { readonly ok: false; readonly reason: SkipReason };

/**
 * Id de unidade: `seg-0#text@7`. O sufixo é o token do plano, único por
 * applier, para que um resultado de um plano substituído (mesmo `segmentId`
 * de outra segmentação) não encontre nenhuma unidade do plano atual.
 */
function unitIdOf(segmentId: string, part: string, token: number): string {
  return `${segmentId}#${part}@${token}`;
}

function perNodePlan(
  segmentId: string,
  nodes: readonly Text[],
  snapshot: readonly string[],
  token: number,
): Planned {
  const units: NodeUnit[] = [];
  nodes.forEach((node, index) => {
    const original = snapshot[index] as string;
    if (!LETTER.test(original)) return;
    units.push({
      unitId: unitIdOf(segmentId, `node-${index}`, token),
      source: collapse(original),
      node,
      original,
    });
  });
  return {
    plan: {
      segmentId,
      kind: 'per_node',
      units: units.map(({ unitId, source }) => ({ unitId, text: source })),
    },
    strategy: { kind: 'per_node', units },
  };
}

function planSegment(
  segment: TranslationSegment,
  snapshot: readonly string[],
  token: number,
): Planned {
  const { id, nodes } = segment;
  const layout = inlineLayoutOf(segment);

  if (layout === null) {
    const content = nodes.flatMap((node, index) =>
      HAS_CONTENT.test(snapshot[index] as string) ? [index] : [],
    );
    const index = content[0];
    if (content.length !== 1 || index === undefined) return perNodePlan(id, nodes, snapshot, token);
    const unit: NodeUnit = {
      unitId: unitIdOf(id, 'text', token),
      source: segment.text,
      node: nodes[index] as Text,
      original: snapshot[index] as string,
    };
    return {
      plan: { segmentId: id, kind: 'plain', units: [{ unitId: unit.unitId, text: unit.source }] },
      strategy: { kind: 'plain', unit },
    };
  }

  if (layout === INLINE_LIMITS_EXCEEDED) return perNodePlan(id, nodes, snapshot, token);
  const encoded = encodeMarkers(layout.layout);
  if (encoded === null) return perNodePlan(id, nodes, snapshot, token);

  // `node.data` é o snapshot: tudo aqui roda no mesmo `plan`, sem `await`.
  const targets: RunTarget[] = [];
  for (const run of layout.runNodes) {
    const content = run.filter((node) => HAS_CONTENT.test(node.data));
    if (content.length > 1) return perNodePlan(id, nodes, snapshot, token);
    const target = content[0] ?? run[0];
    if (target === undefined) return perNodePlan(id, nodes, snapshot, token);
    targets.push({ node: target, original: target.data, literal: run.length === 1 });
  }
  const unitId = unitIdOf(id, 'markers', token);
  return {
    plan: { segmentId: id, kind: 'markers', units: [{ unitId, text: encoded }] },
    strategy: { kind: 'markers', unitId, layout: layout.layout, targets },
  };
}

/**
 * O pai do nó está agora numa área que a coleta excluiria (subindo até o
 * bloco do segmento, inclusive) ou num contexto editável: escrever ali
 * mexeria em código, campo de formulário ou texto que o usuário edita.
 */
function isRefusedContext(node: Text, block: Element): boolean {
  for (let element = node.parentElement; element !== null; element = element.parentElement) {
    if (isExcludedElement(element)) return true;
    if (element === block) break;
  }
  return isInEditableContext(node);
}

/**
 * Maior saída do modelo aceita por unidade: 4× o maior segmento (a razão
 * máxima de letras) mais folga para marcadores e espaço. Acima disso a saída
 * é `implausible_output` antes de qualquer processamento (trim, razão de
 * letras ou decode), para que uma resposta degenerada não seja varrida inteira.
 */
export const MAX_OUTPUT_CHARS = 4 * MAX_SEGMENT_CHARS + 1024;

function resultOf(results: ReadonlyMap<string, string | null>, unitId: string): string | null {
  const value: unknown = results.get(unitId);
  return typeof value === 'string' ? value : null;
}

/** Tradução de um nó com bordas originais, ou o motivo da recusa. */
function nodeWrite(
  unit: NodeUnit,
  results: ReadonlyMap<string, string | null>,
): Write | SkipReason {
  const output = resultOf(results, unit.unitId);
  if (output === null) return 'translation_failed';
  if (output.length > MAX_OUTPUT_CHARS) return 'implausible_output';
  const translation = trimAscii(output);
  if (translation === '' || !checkLetterRatio(unit.source, translation)) {
    return 'implausible_output';
  }
  return { node: unit.node, value: withOriginalEdges(unit.original, translation) };
}

function buildWrites(strategy: Strategy, results: ReadonlyMap<string, string | null>): BuildResult {
  switch (strategy.kind) {
    case 'plain': {
      const write = nodeWrite(strategy.unit, results);
      return typeof write === 'string'
        ? { ok: false, reason: write }
        : { ok: true, writes: [write] };
    }
    case 'markers': {
      const output = resultOf(results, strategy.unitId);
      if (output === null) return { ok: false, reason: 'translation_failed' };
      if (output.length > MAX_OUTPUT_CHARS) return { ok: false, reason: 'implausible_output' };
      const decoded = decodeMarkers(output, strategy.layout);
      if (!decoded.ok) return { ok: false, reason: 'markers_invalid' };
      const writes: Write[] = [];
      strategy.targets.forEach(({ node, original, literal }, index) => {
        const text = decoded.texts[index] as string;
        if (literal) {
          writes.push({ node, value: text });
          return;
        }
        const translation = trimAscii(text);
        if (translation === '' && !HAS_CONTENT.test(original)) return;
        writes.push({ node, value: withOriginalEdges(original, translation) });
      });
      return { ok: true, writes };
    }
    case 'per_node': {
      if (strategy.units.length === 0) return { ok: false, reason: 'translation_failed' };
      const writes: Write[] = [];
      // Primeiro motivo de recusa vence; `translation_failed` antes de
      // `implausible_output` só pela ordem dos nós.
      for (const unit of strategy.units) {
        const write = nodeWrite(unit, results);
        if (typeof write === 'string') return { ok: false, reason: write };
        writes.push(write);
      }
      return { ok: true, writes };
    }
  }
}

interface RegistryEntry {
  readonly original: string;
  applied: string;
}

export function createPageApplier(): PageApplier {
  const registry = new Map<Text, RegistryEntry>();
  const pending = new Map<string, PendingPlan | 'segment_too_long'>();
  let nextToken = 0;

  const write = (node: Text, value: string): void => {
    if (node.data === value) return;
    const entry = registry.get(node);
    // Sem entrada, ou o site trocou o texto aplicado: o `data` atual passa a
    // ser o original (restaurar o antigo apagaria a mudança do site).
    if (entry === undefined || node.data !== entry.applied) {
      registry.set(node, { original: node.data, applied: value });
    } else {
      entry.applied = value;
    }
    node.data = value;
  };

  const unchanged = ({ block, nodes, snapshot, parents }: PendingPlan): boolean => {
    const checked = new Set<ParentNode>();
    return nodes.every((node, index) => {
      const parent = node.parentNode;
      if (!node.isConnected || node.data !== snapshot[index] || parent !== parents[index]) {
        return false;
      }
      if (parent === null || checked.has(parent)) return true;
      checked.add(parent);
      return !isRefusedContext(node, block);
    });
  };

  /**
   * Passa por todo o registro escrevendo `to` onde o nó ainda tem `from`.
   * Entradas de nós desconectados contam como puladas e saem do registro
   * (libera memória; o nó não volta a ser tocado mesmo se for reinserido).
   */
  const sweep = (from: 'applied' | 'original'): { written: number; skipped: number } => {
    const to = from === 'applied' ? 'original' : 'applied';
    let written = 0;
    let skipped = 0;
    for (const [node, entry] of registry) {
      if (!node.isConnected) {
        registry.delete(node);
        skipped += 1;
      } else if (node.data === entry[from] && !isInEditableContext(node)) {
        node.data = entry[to];
        written += 1;
      } else {
        skipped += 1;
      }
    }
    return { written, skipped };
  };

  return {
    plan(segment) {
      if (segment.text.length > MAX_SEGMENT_CHARS) {
        pending.set(segment.id, 'segment_too_long');
        return { segmentId: segment.id, skipped: 'segment_too_long' };
      }
      const nodes = [...segment.nodes];
      const snapshot = nodes.map((node) => node.data);
      const parents = nodes.map((node) => node.parentNode);
      const { plan, strategy } = planSegment(segment, snapshot, nextToken++);
      pending.set(segment.id, { block: segment.block, nodes, snapshot, parents, plan, strategy });
      return plan;
    },

    apply(segmentId, results) {
      const entry = pending.get(segmentId);
      if (entry === undefined) return { ok: false, reason: 'unknown_segment' };
      pending.delete(segmentId);
      if (entry === 'segment_too_long') return { ok: false, reason: 'segment_too_long' };
      if (!unchanged(entry)) return { ok: false, reason: 'node_changed' };

      const built = buildWrites(entry.strategy, results);
      if (!built.ok) {
        if (built.reason !== 'markers_invalid') return { ok: false, reason: built.reason };
        const fallback = perNodePlan(segmentId, entry.nodes, entry.snapshot, nextToken++);
        pending.set(segmentId, { ...entry, ...fallback });
        return { ok: false, reason: 'markers_invalid', fallback: fallback.plan };
      }
      for (const { node, value } of built.writes) write(node, value);
      return { ok: true };
    },

    restore() {
      const { written, skipped } = sweep('applied');
      return { restored: written, skipped };
    },

    reapply() {
      const { written, skipped } = sweep('original');
      return { reapplied: written, skipped };
    },

    clear() {
      registry.clear();
      pending.clear();
    },
  };
}

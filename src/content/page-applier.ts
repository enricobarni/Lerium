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
 *   (`encodeMarkers`). O texto de cada run decodificado vai literalmente ao
 *   único nó com conteúdo do run (ou ao primeiro nó, se o run é só espaço).
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
 * conectados e com o mesmo `data` capturado no `plan` (`node_changed`). No
 * `per_node`, uma unidade sem resultado (`translation_failed`) ou implausível
 * (`implausible_output`) deixa o segmento inteiro no original: aplicar só
 * parte dos nós misturaria idiomas dentro de uma frase. As escritas são
 * síncronas, sem `await` entre elas.
 *
 * Plausibilidade: tradução vazia ou com razão de letras fora de
 * `checkLetterRatio` é `implausible_output` (no `markers`, o codec já aplica
 * a mesma razão e o erro vira `markers_invalid`).
 *
 * Restauração: o registro guarda, por nó, o `original` (gravado só na
 * primeira escrita) e o último `applied`. `restore` só escreve o original em
 * nós conectados cujo `data` ainda é o aplicado; `reapply` só escreve o
 * aplicado em nós conectados cujo `data` ainda é o original. Um nó que o site
 * alterou depois da escrita não é tocado.
 */

import { decodeMarkers, encodeMarkers, type InlineLayout } from '../core/inline-markers';
import { checkLetterRatio } from '../core/letter-ratio';
import { INLINE_LIMITS_EXCEEDED, inlineLayoutOf } from './inline-layout';
import { MAX_SEGMENT_CHARS, type TranslationSegment } from './segmenter';

export type UnitKind = 'plain' | 'markers' | 'per_node';

/** Texto a enviar ao modelo; `unitId` identifica o resultado no `apply`. */
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
      /** Nó de destino de cada run, na ordem de `layout.runs`. */
      readonly targets: readonly Text[];
    }
  | { readonly kind: 'per_node'; readonly units: readonly NodeUnit[] };

interface PendingPlan {
  readonly nodes: readonly Text[];
  /** `data` de cada nó de `nodes` no momento do `plan`. */
  readonly snapshot: readonly string[];
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

function perNodePlan(
  segmentId: string,
  nodes: readonly Text[],
  snapshot: readonly string[],
): Planned {
  const units: NodeUnit[] = [];
  nodes.forEach((node, index) => {
    const original = snapshot[index] as string;
    if (!LETTER.test(original)) return;
    units.push({
      unitId: `${segmentId}#node-${index}`,
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

function planSegment(segment: TranslationSegment, snapshot: readonly string[]): Planned {
  const { id, nodes } = segment;
  const layout = inlineLayoutOf(segment);

  if (layout === null) {
    const content = nodes.flatMap((node, index) =>
      HAS_CONTENT.test(snapshot[index] as string) ? [index] : [],
    );
    const index = content[0];
    if (content.length !== 1 || index === undefined) return perNodePlan(id, nodes, snapshot);
    const unit: NodeUnit = {
      unitId: `${id}#text`,
      source: segment.text,
      node: nodes[index] as Text,
      original: snapshot[index] as string,
    };
    return {
      plan: { segmentId: id, kind: 'plain', units: [{ unitId: unit.unitId, text: unit.source }] },
      strategy: { kind: 'plain', unit },
    };
  }

  if (layout === INLINE_LIMITS_EXCEEDED) return perNodePlan(id, nodes, snapshot);
  const encoded = encodeMarkers(layout.layout);
  if (encoded === null) return perNodePlan(id, nodes, snapshot);

  const targets: Text[] = [];
  for (const run of layout.runNodes) {
    const content = run.filter((node) => HAS_CONTENT.test(node.data));
    if (content.length > 1) return perNodePlan(id, nodes, snapshot);
    const target = content[0] ?? run[0];
    if (target === undefined) return perNodePlan(id, nodes, snapshot);
    targets.push(target);
  }
  const unitId = `${id}#markers`;
  return {
    plan: { segmentId: id, kind: 'markers', units: [{ unitId, text: encoded }] },
    strategy: { kind: 'markers', unitId, layout: layout.layout, targets },
  };
}

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
      const decoded = decodeMarkers(output, strategy.layout);
      if (!decoded.ok) return { ok: false, reason: 'markers_invalid' };
      const writes = strategy.targets.map((node, index) => ({
        node,
        value: decoded.texts[index] as string,
      }));
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

  const write = (node: Text, value: string): void => {
    if (node.data === value) return;
    const entry = registry.get(node);
    if (entry === undefined) registry.set(node, { original: node.data, applied: value });
    else entry.applied = value;
    node.data = value;
  };

  const unchanged = ({ nodes, snapshot }: PendingPlan): boolean =>
    nodes.every((node, index) => node.isConnected && node.data === snapshot[index]);

  return {
    plan(segment) {
      if (segment.text.length > MAX_SEGMENT_CHARS) {
        pending.set(segment.id, 'segment_too_long');
        return { segmentId: segment.id, skipped: 'segment_too_long' };
      }
      const nodes = [...segment.nodes];
      const snapshot = nodes.map((node) => node.data);
      const { plan, strategy } = planSegment(segment, snapshot);
      pending.set(segment.id, { nodes, snapshot, plan, strategy });
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
        const fallback = perNodePlan(segmentId, entry.nodes, entry.snapshot);
        pending.set(segmentId, { ...entry, ...fallback });
        return { ok: false, reason: 'markers_invalid', fallback: fallback.plan };
      }
      for (const { node, value } of built.writes) write(node, value);
      return { ok: true };
    },

    restore() {
      let restored = 0;
      let skipped = 0;
      for (const [node, entry] of registry) {
        if (node.isConnected && node.data === entry.applied) {
          node.data = entry.original;
          restored += 1;
        } else {
          skipped += 1;
        }
      }
      return { restored, skipped };
    },

    reapply() {
      let reapplied = 0;
      let skipped = 0;
      for (const [node, entry] of registry) {
        if (node.isConnected && node.data === entry.original) {
          node.data = entry.applied;
          reapplied += 1;
        } else {
          skipped += 1;
        }
      }
      return { reapplied, skipped };
    },

    clear() {
      registry.clear();
      pending.clear();
    },
  };
}

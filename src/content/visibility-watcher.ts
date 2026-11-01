/**
 * Observa a visibilidade dos blocos em fila e informa em que zona cada um está:
 * `visible` (interseca a viewport), `near` (até uma viewport abaixo dela) ou `out`.
 *
 * Por que dois observadores: um IntersectionObserver só notifica quando o alvo cruza
 * um limiar da raiz (já expandida pelo `rootMargin`). Com um único observador de raiz
 * expandida, a passagem `near` → `visible` acontece inteira dentro dessa raiz e não
 * gera entrada nenhuma. Por isso há um observador para a viewport (`rootMargin: 0px`)
 * e outro para a faixa próxima (`NEAR_ROOT_MARGIN`), ambos com `threshold: 0`.
 *
 * Privacidade: o IntersectionObserver criado no mundo isolado do content script não
 * altera o DOM nem cria objetos acessíveis aos scripts da página; nada é exposto a ela.
 * A geometria nunca é lida de forma síncrona (sem getBoundingClientRect), o que evita
 * reflows forçados.
 */

export type VisibilityZone = 'visible' | 'near' | 'out';

export interface VisibilityChange {
  readonly block: Element;
  readonly zone: VisibilityZone;
}

/**
 * O que o watcher lê de uma `IntersectionObserverEntry`. `boundingClientRect` e
 * `rootBounds` já vêm calculados na entrada (sem reflow); servem só para saber se um
 * bloco que deixou de intersectar está acima da viewport.
 */
export interface ObservedEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly boundingClientRect?: { readonly bottom: number };
  readonly rootBounds?: { readonly top: number } | null;
}

export interface ObserverLike {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (
  callback: (entries: readonly ObservedEntry[]) => void,
  options: { rootMargin: string; threshold: number },
) => ObserverLike;

export interface VisibilityWatcher {
  observe(block: Element): void;
  unobserve(block: Element): void;
  disconnect(): void;
}

/** Estende a raiz uma viewport inteira para baixo: o que vem logo a seguir na leitura. */
export const NEAR_ROOT_MARGIN = '0px 0px 100% 0px';

const VISIBLE_ROOT_MARGIN = '0px';

interface BlockState {
  inVisible: boolean;
  inNear: boolean;
  /** O observador da viewport já entregou a primeira entrada do bloco. */
  seenVisible: boolean;
  /** O observador da faixa próxima já entregou a primeira entrada do bloco. */
  seenNear: boolean;
  /** Última zona emitida; `undefined` até os dois observadores entregarem a primeira entrada. */
  zone: VisibilityZone | undefined;
}

type Flag = 'inVisible' | 'inNear';

const SEEN: Record<Flag, 'seenVisible' | 'seenNear'> = {
  inVisible: 'seenVisible',
  inNear: 'seenNear',
};

/** Fora da raiz e com a borda de baixo acima do topo dela: o bloco está acima da viewport. */
function isAbove(entry: ObservedEntry): boolean {
  if (entry.isIntersecting || entry.boundingClientRect === undefined) return false;
  return entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
}

const initialState = (): BlockState => ({
  inVisible: false,
  inNear: false,
  seenVisible: false,
  seenNear: false,
  zone: undefined,
});

function zoneOf(state: BlockState): VisibilityZone {
  if (state.inVisible) return 'visible';
  if (state.inNear) return 'near';
  return 'out';
}

/**
 * Cria o observador. Um bloco não tem zona até os dois observadores entregarem a
 * primeira entrada dele (a ordem entre os dois callbacks no mesmo quadro não é
 * garantida); aí a zona inicial é emitida, qualquer que seja, inclusive `out`. Depois,
 * só mudanças de zona são emitidas, um lote por callback de observador, na ordem das
 * entradas. Sem timers: se os dois observadores disparam no mesmo quadro, cada um
 * emite o próprio lote.
 *
 * Bloco que deixou de intersectar com a borda de baixo acima do topo da raiz está
 * acima da viewport e, portanto, fora da faixa próxima (que só se estende para baixo):
 * vai direto para `out`, sem esperar o observador da faixa próxima.
 *
 * `unobserve` seguido de `observe` recomeça do zero: exige as duas entradas iniciais.
 */
export function createVisibilityWatcher(
  factory: ObserverFactory,
  onChange: (changes: readonly VisibilityChange[]) => void,
): VisibilityWatcher {
  const states = new Map<Element, BlockState>();
  let connected = true;

  const handle =
    (flag: Flag) =>
    (entries: readonly ObservedEntry[]): void => {
      if (!connected) return;
      // Zona de cada bloco antes deste lote, na ordem da primeira entrada dele.
      const before = new Map<Element, VisibilityZone | undefined>();
      for (const entry of entries) {
        const state = states.get(entry.target);
        if (state === undefined) continue; // não observado (ou já removido)
        if (!before.has(entry.target)) before.set(entry.target, state.zone);
        state[flag] = entry.isIntersecting;
        state[SEEN[flag]] = true;
        if (isAbove(entry)) state.inNear = false;
        state.zone = state.seenVisible && state.seenNear ? zoneOf(state) : undefined;
      }
      const changes: VisibilityChange[] = [];
      for (const [block, previous] of before) {
        const zone = states.get(block)?.zone;
        if (zone !== undefined && zone !== previous) changes.push({ block, zone });
      }
      if (changes.length > 0) onChange(changes);
    };

  const visibleObserver = factory(handle('inVisible'), {
    rootMargin: VISIBLE_ROOT_MARGIN,
    threshold: 0,
  });
  const nearObserver = factory(handle('inNear'), { rootMargin: NEAR_ROOT_MARGIN, threshold: 0 });

  return {
    observe(block) {
      if (!connected || states.has(block)) return;
      states.set(block, initialState());
      visibleObserver.observe(block);
      nearObserver.observe(block);
    },
    unobserve(block) {
      if (!states.delete(block)) return;
      visibleObserver.unobserve(block);
      nearObserver.unobserve(block);
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      states.clear();
      visibleObserver.disconnect();
      nearObserver.disconnect();
    },
  };
}

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

export interface ObservedEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
}

export interface ObserverLike {
  observe(el: Element): void;
  unobserve(el: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (
  callback: (entries: readonly { target: Element; isIntersecting: boolean }[]) => void,
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
  zone: VisibilityZone;
}

type Flag = 'inVisible' | 'inNear';

function zoneOf(state: BlockState): VisibilityZone {
  if (state.inVisible) return 'visible';
  if (state.inNear) return 'near';
  return 'out';
}

/**
 * Cria o observador. Todo bloco começa em `out`; só mudanças de zona são emitidas,
 * um lote por callback de observador, na ordem das entradas. Sem timers: se os dois
 * observadores disparam no mesmo quadro, cada um emite o próprio lote.
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
      const before = new Map<Element, VisibilityZone>();
      for (const entry of entries) {
        const state = states.get(entry.target);
        if (state === undefined) continue; // não observado (ou já removido)
        if (!before.has(entry.target)) before.set(entry.target, state.zone);
        state[flag] = entry.isIntersecting;
        state.zone = zoneOf(state);
      }
      const changes: VisibilityChange[] = [];
      for (const [block, previous] of before) {
        const state = states.get(block);
        if (state !== undefined && state.zone !== previous) {
          changes.push({ block, zone: state.zone });
        }
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
      states.set(block, { inVisible: false, inNear: false, zone: 'out' });
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

/**
 * Regra única de zona por retângulo, usada pela classificação inicial
 * (`segment-priority.ts`) e pelo rastreador por trecho
 * (`segment-zone-tracker.ts`). Função pura: não lê o DOM.
 */

/** Retângulo em coordenadas da viewport (como `DOMRect`). */
export interface ZoneRect {
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** Zona de um retângulo em relação à viewport. */
export type RectZone = 'visible' | 'near' | 'out';

/** Largura e altura positivas (`NaN` não tem área). */
export function hasArea(rect: ZoneRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

/**
 * Zona do retângulo:
 * - `visible`: tem área e cruza a faixa vertical `(0, viewportHeight)`;
 * - `near`: tem área e começa na primeira viewport abaixo da tela
 *   (`viewportHeight <= top < 2 * viewportHeight`);
 * - `out`: o resto (sem área, nó desconectado, acima, mais abaixo ou `NaN`).
 */
export function zoneOfRect(rect: ZoneRect, viewportHeight: number): RectZone {
  if (!hasArea(rect)) return 'out';
  if (rect.top < viewportHeight && rect.bottom > 0) return 'visible';
  if (rect.top >= viewportHeight && rect.top < 2 * viewportHeight) return 'near';
  return 'out';
}

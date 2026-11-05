import type { PageStateView } from '../shared/page-control';
import {
  NO_TEXT_MESSAGE,
  NOTHING_TRANSLATED_MESSAGE,
  partialMessage,
  STATE_ERROR_MESSAGES,
  TRANSLATED_MESSAGE,
  TRANSLATING_ANNOUNCE,
  translatingMessage,
} from '../shared/page-status-text';

/**
 * Modelo do indicador de progresso na página. Módulo puro, sem `chrome` nem
 * DOM. As mensagens são as do popup (`page-status-text`): do estado só entram
 * contagens, nunca texto da página.
 *
 * Descreve um estado isolado. Quando o indicador aparece (só depois de um
 * `translating`) e quando some de vez é decidido por `progress-overlay.ts`,
 * que guarda o histórico.
 */

export type ProgressTone = 'info' | 'success' | 'warning' | 'error';

export interface ProgressViewModel {
  /** Texto visível (pode ter contagens). */
  message: string;
  /** Texto da região viva: sem contagens durante a tradução, para não repetir anúncios. */
  announce: string;
  tone: ProgressTone;
  /** Ausente quando não há barra (fora de `translating` ou total zero). */
  progress?: { value: number; max: number };
  /** Some sozinho depois de um tempo (só no sucesso completo). */
  autoHide: boolean;
}

function model(
  message: string,
  tone: ProgressTone,
  options: { announce?: string; autoHide?: boolean } = {},
): ProgressViewModel {
  return {
    message,
    announce: options.announce ?? message,
    tone,
    autoHide: options.autoHide ?? false,
  };
}

/** `null`: o indicador fica oculto. */
export function describeProgress(state: PageStateView): ProgressViewModel | null {
  const { status, view, total, done, failed, skipped } = state;

  // Cancelar ou voltar ao original é ação do usuário: nada a informar na página.
  if (status === 'idle' || status === 'cancelled' || view === 'original') return null;

  if (status === 'translating') {
    const processed = Math.min(done + failed + skipped, total);
    const translating = model(translatingMessage(processed, total), 'info', {
      announce: TRANSLATING_ANNOUNCE,
    });
    // `<progress>` exige `max` positivo; sem total, a barra fica oculta.
    return total > 0 ? { ...translating, progress: { value: processed, max: total } } : translating;
  }

  if (status === 'error') return model(STATE_ERROR_MESSAGES[state.error ?? 'interrupted'], 'error');

  // status === 'translated'
  if (total === 0) return model(NO_TEXT_MESSAGE, 'warning');
  if (done === 0) return model(NOTHING_TRANSLATED_MESSAGE, 'warning');
  const untranslated = failed + skipped;
  if (untranslated > 0) return model(partialMessage(untranslated), 'warning');
  return model(TRANSLATED_MESSAGE, 'success', { autoHide: true });
}

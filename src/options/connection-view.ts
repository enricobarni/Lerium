import type { TestConnectionResponse } from '../shared/runtime-messages';
import { connectedMessage, connectionErrorMessage, missingModelMessage } from './messages';

/**
 * Decide o que a página de opções mostra após um teste de conexão. Módulo
 * puro (sem DOM, sem `chrome`) para ser testável no Node; `index.ts` só
 * aplica o resultado.
 */

/** Resposta do service worker ou falha local ao falar com ele. */
export type ConnectionResult = TestConnectionResponse | { ok: false; error: 'extension_error' };

export type ConnectionTone = 'success' | 'error' | 'warning';

export interface ConnectionView {
  message: string;
  tone: ConnectionTone;
  /** Mostra a seção de liberação da origem; só quando o Ollama recusou (403). */
  revealOriginHelp: boolean;
  /** Leva o foco até a seção; só na recusa de um teste pedido pelo usuário. */
  focusOriginHelp: boolean;
  /** Aviso não bloqueante de modelo ausente. */
  modelWarning?: string;
}

export interface DescribeOptions {
  /** Teste disparado pelo usuário; o automático ao abrir não move o foco. */
  userInitiated: boolean;
  /** Modelo testado, já validado; compõe o aviso de modelo ausente. */
  model?: string;
}

export function describeConnectionResult(
  result: ConnectionResult,
  { userInitiated, model }: DescribeOptions,
): ConnectionView {
  if (result.ok) {
    const view: ConnectionView = {
      message: connectedMessage(result.models.length),
      tone: 'success',
      revealOriginHelp: false,
      focusOriginHelp: false,
    };
    if (!result.modelInstalled && model !== undefined) {
      view.modelWarning = missingModelMessage(model);
    }
    return view;
  }
  const forbidden = result.error === 'forbidden';
  const status = 'status' in result ? result.status : undefined;
  return {
    message: connectionErrorMessage(result.error, status),
    // Falta de permissão é um passo pendente do usuário, não uma falha.
    tone: result.error === 'permission_required' ? 'warning' : 'error',
    revealOriginHelp: forbidden,
    focusOriginHelp: forbidden && userInitiated,
  };
}

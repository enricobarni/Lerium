/**
 * Controlador do content script: recebe os comandos do popup
 * (`chrome.tabs.sendMessage`) e os traduz em chamadas ao `JobRunner`.
 * Sem `chrome`: a entrada (`index.ts`) faz só a ligação.
 *
 * Regras:
 * - Só aceita remetente da própria extensão: `sender.id === runtimeId` e
 *   `sender.url` dentro de `extensionOrigin` (`chrome-extension://<id>/`).
 *   Isso exclui content scripts (cuja `url` é a da página) e outras
 *   extensões. Remetente não confiável não recebe resposta (`undefined`).
 * - Mensagem de remetente confiável passa por `parsePageCommand`; inválida →
 *   `{ ok: false, error: 'invalid_request' }`.
 * - Todo comando responde de forma síncrona com o estado atual, mapeado
 *   campo a campo para `PageStateView` (só contagens e códigos, sem texto).
 * - `onPageHide(persisted)`: página indo para o bfcache (`persisted`) só
 *   cancela o job (a porta não sobrevive ao cache e o usuário pode reiniciar
 *   na volta); descarregamento definitivo descarta o runner (`dispose`).
 */

import {
  parsePageCommand,
  type PageCommandResponse,
  type PageStateView,
} from '../shared/page-control';
import type { JobRunner, JobState } from './job-runner';

export interface ContentControllerDeps {
  runner: JobRunner;
  /** `chrome.runtime.id`. */
  runtimeId: string;
  /** `chrome.runtime.getURL('')`, isto é, `chrome-extension://<id>/`. */
  extensionOrigin: string;
}

export interface MessageSenderLike {
  readonly id?: string;
  readonly url?: string;
}

export interface ContentController {
  handleMessage(message: unknown, sender: MessageSenderLike): PageCommandResponse | undefined;
  onPageHide(persisted: boolean): void;
}

/** Cópia explícita: nenhum campo além do contrato atravessa a mensagem. */
export function toPageStateView(state: JobState): PageStateView {
  const view: PageStateView = {
    status: state.status,
    view: state.view,
    total: state.total,
    done: state.done,
    failed: state.failed,
    skipped: state.skipped,
  };
  if (state.error !== undefined) view.error = state.error;
  return view;
}

export function createContentController(deps: ContentControllerDeps): ContentController {
  const { runner, runtimeId, extensionOrigin } = deps;
  const originValid = runtimeId !== '' && extensionOrigin === `chrome-extension://${runtimeId}/`;

  const isTrusted = (sender: MessageSenderLike): boolean =>
    originValid &&
    sender.id === runtimeId &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(extensionOrigin);

  return {
    handleMessage(message, sender) {
      if (!isTrusted(sender)) return undefined;
      const command = parsePageCommand(message);
      if (command === null) return { ok: false, error: 'invalid_request' };
      switch (command.command) {
        case 'start':
          runner.start();
          break;
        case 'cancel':
          runner.cancel();
          break;
        case 'show-original':
          runner.showOriginal();
          break;
        case 'show-translation':
          runner.showTranslation();
          break;
        case 'get-state':
          break;
      }
      return { ok: true, state: toPageStateView(runner.getState()) };
    },

    onPageHide(persisted) {
      if (persisted) runner.cancel();
      else runner.dispose();
    },
  };
}

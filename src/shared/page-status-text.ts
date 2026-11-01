import type { PageStateError } from './page-control';

/**
 * Textos de estado da página, usados pelo popup e pelo indicador de progresso
 * na página. Módulo puro, sem `chrome` nem DOM. As mensagens são fixas: do
 * estado só entram contagens, nunca texto da página.
 */

export const READY_MESSAGE = 'Pronto para traduzir esta página.';
export const BUSY_MESSAGE = 'Preparando a página…';
/** Anúncio de "traduzindo": sem contagens, para não repetir a cada progresso. */
export const TRANSLATING_ANNOUNCE = 'Traduzindo a página.';
export const TRANSLATED_MESSAGE = 'Página traduzida.';
export const NOTHING_TRANSLATED_MESSAGE = 'Nenhum trecho foi traduzido.';
export const NO_TEXT_MESSAGE = 'Não há texto para traduzir nesta página.';
export const SHOWING_ORIGINAL_MESSAGE = 'Mostrando o texto original.';
export const CANCELLED_MESSAGE = 'Tradução cancelada.';
export const UNSUPPORTED_MESSAGE =
  'Esta página não pode ser traduzida. Páginas do Chrome, da Chrome Web Store, PDFs e ' +
  'outras extensões não são suportados.';
export const PREPARE_FAILED_MESSAGE =
  'Não foi possível preparar a página. Recarregue e tente de novo.';
export const COMMAND_FAILED_MESSAGE =
  'Não foi possível falar com a página. Recarregue a página e tente de novo.';
export const INVALID_CONFIG_MESSAGE = 'Configuração inválida. Revise as configurações.';

/** Mensagem de cada erro do job. */
export const STATE_ERROR_MESSAGES: Readonly<Record<PageStateError, string>> = Object.freeze({
  network: 'O Ollama não respondeu. Verifique se ele está aberto e tente de novo.',
  forbidden:
    'O Ollama recusou o Lerium. Libere a origem do Lerium em OLLAMA_ORIGINS ' +
    '(veja as configurações).',
  model_missing: 'O modelo configurado não está instalado no Ollama.',
  invalid_config: INVALID_CONFIG_MESSAGE,
  settings_unavailable: INVALID_CONFIG_MESSAGE,
  interrupted: 'A tradução foi interrompida. Tente de novo.',
});

const trechos = (count: number): string => (count === 1 ? 'trecho' : 'trechos');

export const translatingMessage = (processed: number, total: number): string =>
  total === 0 ? 'Traduzindo…' : `Traduzindo… ${processed} de ${total} ${trechos(total)}.`;

export const partialMessage = (untranslated: number): string =>
  untranslated === 1
    ? `${TRANSLATED_MESSAGE} 1 trecho continua no original.`
    : `${TRANSLATED_MESSAGE} ${untranslated} trechos continuam no original.`;

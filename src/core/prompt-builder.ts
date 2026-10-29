import { isLanguageCode, validateModel } from '../shared/validation';
import type { LanguageCode } from './types';

/**
 * PromptBuilder versionado (RF05, PLAN.md §9; proposta na ADR-011). Módulo
 * puro: monta o corpo de `POST /api/chat` sem referenciar `chrome` nem DOM.
 *
 * Formato: o recomendado para o TranslateGemma no model card do Google (a
 * confirmar no model card oficial e validar com o modelo real na branch de
 * serviço). É o baseline curto da política de prompt do PLAN.md §9; uma
 * variante literária mais longa fica para A/B manual futuro, com nova versão.
 *
 * Por que uma única mensagem `user`: o template do `translategemma:4b`
 * (Ollama 0.40.12) não tem papel `system` — `system` e `user` viram ambos
 * `<start_of_turn>user`. Mandar system+user geraria dois turnos de usuário.
 *
 * Defesa contra injeção de prompt: o texto da página é DADO. A instrução é
 * fixa e vem antes; o texto entra uma única vez, inalterado, ao final; a
 * saída do modelo é tratada como texto puro pela aplicação (`textContent`).
 * Não usamos delimitadores XML: o template e o formato recomendado não os
 * preveem, e o modelo poderia traduzi-los ou ecoá-los na saída. O teste com
 * o modelo real decidirá se alguma delimitação extra é necessária.
 *
 * Qualquer mudança no texto do prompt ou nos parâmetros exige nova versão.
 */
export const PROMPT_VERSION = 'v1-translategemma-baseline';

/**
 * Nomes de idioma em inglês, no formato que o prompt do TranslateGemma usa.
 * São distintos dos rótulos PT-BR da interface (`LANGUAGES` em constants.ts).
 */
export const PROMPT_LANGUAGE_NAMES: Readonly<Record<LanguageCode, string>> = Object.freeze({
  en: 'English',
  'pt-BR': 'Brazilian Portuguese',
  es: 'Spanish',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Simplified Chinese',
});

/**
 * O modelfile não define temperatura (só `top_k 64`, `top_p 0.95`), então o
 * padrão do Ollama valeria. Tradução pede saída estável e fiel, não
 * criatividade: um valor baixo reduz variação entre execuções sem chegar ao
 * greedy puro (0), que tende a repetições. A calibrar no A/B.
 */
export const PROMPT_TEMPERATURE = 0.2;

/**
 * Limite de tokens gerados, contra geração sem fim (laço de repetição ou
 * `<end_of_turn>` nunca emitido). Heurística: ~metade do nº de caracteres
 * da entrada. Em línguas latinas um token tem ~3–4 caracteres, então
 * `chars/2` dá folga de ~1,5–2× para a tradução crescer (pt-BR costuma ser
 * mais longo que en). Em CJK cada caractere pode virar 1+ token na saída
 * latina; o piso cobre trechos curtos. O teto limita o pior caso por
 * segmento. Não definimos `num_ctx` nem `keep_alive`: ficam com o Ollama.
 */
export const NUM_PREDICT_MIN = 256;
export const NUM_PREDICT_MAX = 4096;

export interface BuildChatRequestInput {
  /** Texto da página (dado não confiável). Usado sem trim nem alteração. */
  text: string;
  source: LanguageCode;
  target: LanguageCode;
  model: string;
}

export interface ChatMessage {
  role: 'user';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: [ChatMessage];
  stream: true;
  options: { temperature: number; num_predict: number };
}

export type BuildChatRequestError =
  | 'invalid_text'
  | 'empty_text'
  | 'invalid_source_language'
  | 'invalid_target_language'
  | 'same_language'
  | 'invalid_model';

export type BuildChatRequestResult =
  { ok: true; request: ChatRequest } | { ok: false; error: BuildChatRequestError };

const fail = (error: BuildChatRequestError): { ok: false; error: BuildChatRequestError } => ({
  ok: false,
  error,
});

function numPredictFor(text: string): number {
  const proportional = Math.ceil(text.length / 2);
  return Math.min(NUM_PREDICT_MAX, Math.max(NUM_PREDICT_MIN, proportional));
}

function buildContent(text: string, source: LanguageCode, target: LanguageCode): string {
  const src = PROMPT_LANGUAGE_NAMES[source];
  const tgt = PROMPT_LANGUAGE_NAMES[target];
  // Instrução fixa primeiro; o texto da página entra só aqui, ao final.
  return (
    `You are a professional ${src} (${source}) to ${tgt} (${target}) translator. ` +
    `Your goal is to accurately convey the meaning and nuances of the original ${src} text ` +
    `while adhering to ${tgt} grammar, vocabulary, and cultural sensitivities. ` +
    `Produce only the ${tgt} translation, without any additional explanations or commentary. ` +
    `Please translate the following ${src} text into ${tgt}:\n\n\n` +
    text
  );
}

/**
 * Monta o corpo de `POST /api/chat`. Valida as entradas em tempo de execução
 * (os valores podem chegar por mensagem entre contextos) e devolve códigos
 * de erro, nunca mensagens.
 */
export function buildChatRequest(input: BuildChatRequestInput): BuildChatRequestResult {
  const { text, source, target } = input;
  if (typeof text !== 'string') return fail('invalid_text');
  if (text.trim() === '') return fail('empty_text');
  if (!isLanguageCode(source)) return fail('invalid_source_language');
  if (!isLanguageCode(target)) return fail('invalid_target_language');
  if (source === target) return fail('same_language');
  const model = validateModel(input.model);
  if (!model.ok) return fail('invalid_model');

  return {
    ok: true,
    request: {
      model: model.value,
      messages: [{ role: 'user', content: buildContent(text, source, target) }],
      stream: true,
      options: { temperature: PROMPT_TEMPERATURE, num_predict: numPredictFor(text) },
    },
  };
}

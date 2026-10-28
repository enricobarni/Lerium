import { DEFAULT_SETTINGS, LANGUAGES } from '../core/constants';
import type { TranslationSettings } from '../core/types';
import { createSettingsRepository, type SettingsFieldErrors } from '../storage/settings-repository';
import { endpointErrorMessage, languageErrorMessage, modelErrorMessage } from './messages';

const SAVED_MESSAGE = 'Configurações salvas.';
const INVALID_MESSAGE = 'Não foi possível salvar. Corrija os campos indicados.';
const SAVE_ERROR = 'Não foi possível salvar as configurações. Tente novamente.';
const LOAD_ERROR =
  'Não foi possível ler as configurações salvas. O formulário mostra os valores padrão; ' +
  'salvar agora substituirá o que estiver gravado.';
const RESTORED_MESSAGE = 'Valores padrão preenchidos. Clique em Salvar para gravá-los.';

type FieldName = keyof SettingsFieldErrors;

// Ordem visual dos campos: usada para focar o primeiro inválido.
const FIELD_ORDER: readonly FieldName[] = ['endpoint', 'model', 'sourceLanguage', 'targetLanguage'];

function byId<T extends HTMLElement>(id: string, type: { new (): T; prototype: T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Elemento #${id} ausente.`);
  return element;
}

const form = byId('settings-form', HTMLFormElement);
const saveButton = byId('save', HTMLButtonElement);
const restoreButton = byId('restore', HTMLButtonElement);
const feedback = byId('feedback', HTMLParagraphElement);

const endpointInput = byId('endpoint', HTMLInputElement);
const modelInput = byId('model', HTMLInputElement);
const sourceSelect = byId('source-language', HTMLSelectElement);
const targetSelect = byId('target-language', HTMLSelectElement);

const controls: Readonly<Record<FieldName, HTMLInputElement | HTMLSelectElement>> = {
  endpoint: endpointInput,
  model: modelInput,
  sourceLanguage: sourceSelect,
  targetLanguage: targetSelect,
};

const errorElements: Readonly<Record<FieldName, HTMLParagraphElement>> = {
  endpoint: byId('endpoint-error', HTMLParagraphElement),
  model: byId('model-error', HTMLParagraphElement),
  sourceLanguage: byId('source-language-error', HTMLParagraphElement),
  targetLanguage: byId('target-language-error', HTMLParagraphElement),
};

const repository = createSettingsRepository(chrome.storage.local);

/**
 * Bloqueia Salvar e Restaurar durante a leitura inicial e a gravação.
 * Usa aria-disabled em vez de `disabled`: `disabled` tira o foco do botão
 * (vai para o body) e o usuário de teclado/leitor de tela perde a posição.
 */
let busy = true;

function setBusy(value: boolean): void {
  busy = value;
  for (const button of [saveButton, restoreButton]) {
    if (value) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }
}

function populateLanguages(select: HTMLSelectElement): void {
  for (const language of LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  }
}

function fillForm(settings: Readonly<TranslationSettings>): void {
  endpointInput.value = settings.endpoint;
  modelInput.value = settings.model;
  sourceSelect.value = settings.sourceLanguage;
  targetSelect.value = settings.targetLanguage;
}

function announce(message: string): void {
  // Limpa antes de escrever para que leitores de tela anunciem mensagens repetidas.
  feedback.textContent = '';
  requestAnimationFrame(() => {
    feedback.textContent = message;
  });
}

function errorMessage(name: FieldName, errors: SettingsFieldErrors): string | undefined {
  switch (name) {
    case 'endpoint':
      return errors.endpoint && endpointErrorMessage(errors.endpoint);
    case 'model':
      return errors.model && modelErrorMessage(errors.model);
    case 'sourceLanguage':
      return errors.sourceLanguage && languageErrorMessage(errors.sourceLanguage);
    case 'targetLanguage':
      return errors.targetLanguage && languageErrorMessage(errors.targetLanguage);
  }
}

/** Atualiza mensagens e aria-invalid; foca o primeiro campo inválido, se houver. */
function showErrors(errors: SettingsFieldErrors): void {
  let firstInvalid: HTMLInputElement | HTMLSelectElement | undefined;
  for (const name of FIELD_ORDER) {
    const control = controls[name];
    const message = errorMessage(name, errors);
    errorElements[name].textContent = message ?? '';
    if (message) {
      control.setAttribute('aria-invalid', 'true');
      firstInvalid ??= control;
    } else {
      control.removeAttribute('aria-invalid');
    }
  }
  firstInvalid?.focus();
}

async function handleSubmit(): Promise<void> {
  setBusy(true);
  try {
    const result = await repository.save({
      endpoint: endpointInput.value,
      model: modelInput.value,
      sourceLanguage: sourceSelect.value,
      targetLanguage: targetSelect.value,
    });
    if (result.ok) {
      showErrors({});
      // Exibe os valores normalizados (ex.: endereço sem barra final).
      fillForm(result.settings);
      announce(SAVED_MESSAGE);
    } else {
      showErrors(result.errors);
      announce(INVALID_MESSAGE);
    }
  } catch {
    // Sem registrar o erro: ele poderia conter valores digitados pelo usuário.
    announce(SAVE_ERROR);
  } finally {
    setBusy(false);
  }
}

async function init(): Promise<void> {
  populateLanguages(sourceSelect);
  populateLanguages(targetSelect);
  fillForm(DEFAULT_SETTINGS);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Ignora submissões repetidas (Enter ou clique) enquanto houver leitura/gravação.
    if (!busy) void handleSubmit();
  });
  restoreButton.addEventListener('click', () => {
    // Sem isso, o load() inicial sobrescreveria os padrões restaurados.
    if (busy) return;
    fillForm(DEFAULT_SETTINGS);
    showErrors({});
    announce(RESTORED_MESSAGE);
  });

  // Salvar e Restaurar ficam bloqueados até a leitura terminar, para não gravar
  // padrões por engano nem ter o restaurado sobrescrito pelo valor lido.
  setBusy(true);
  try {
    fillForm(await repository.load());
  } catch {
    // Libera o formulário com os padrões, avisando que salvar sobrescreve o gravado.
    fillForm(DEFAULT_SETTINGS);
    announce(LOAD_ERROR);
  } finally {
    setBusy(false);
  }
}

void init();

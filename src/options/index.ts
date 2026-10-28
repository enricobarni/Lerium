import { DEFAULT_SETTINGS, LANGUAGES } from '../core/constants';
import { hasModel, listModels } from '../core/ollama-client';
import type { TranslationSettings } from '../core/types';
import { normalizeEndpoint, validateModel } from '../shared/validation';
import { createSettingsRepository, type SettingsFieldErrors } from '../storage/settings-repository';
import {
  connectedMessage,
  endpointErrorMessage,
  languageErrorMessage,
  missingModelMessage,
  modelErrorMessage,
  ollamaErrorMessage,
} from './messages';

const SAVED_MESSAGE = 'Configurações salvas.';
const INVALID_MESSAGE = 'Não foi possível salvar. Corrija os campos indicados.';
const SAVE_ERROR = 'Não foi possível salvar as configurações. Tente novamente.';
const LOAD_ERROR =
  'Não foi possível ler as configurações salvas. O formulário mostra os valores padrão; ' +
  'salvar agora substituirá o que estiver gravado.';
const RESTORED_MESSAGE = 'Valores padrão preenchidos. Clique em Salvar para gravá-los.';
const TESTING_MESSAGE = 'Testando conexão…';
const TEST_INVALID_MESSAGE = 'Corrija o endereço do Ollama para testar a conexão.';
const INSTALLED_PLACEHOLDER = 'Escolha um modelo instalado';

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
const testButton = byId('test-connection', HTMLButtonElement);
const connectionStatus = byId('connection-status', HTMLParagraphElement);
const modelWarning = byId('model-warning', HTMLParagraphElement);
const installedField = byId('installed-models-field', HTMLDivElement);
const installedSelect = byId('installed-models', HTMLSelectElement);
const originHelp = byId('origin-help', HTMLElement);
const originHelpTitle = byId('origin-help-title', HTMLHeadingElement);

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

/**
 * Bloqueia "Testar conexão" durante a leitura inicial e enquanto um teste
 * roda; mesmo padrão de aria-disabled de `setBusy`. Salvar continua livre.
 */
let testing = true;

function setTesting(value: boolean): void {
  testing = value;
  if (value) testButton.setAttribute('aria-disabled', 'true');
  else testButton.removeAttribute('aria-disabled');
}

/** Modelos do último teste bem-sucedido; `undefined` se não houver lista válida. */
let installedModels: readonly string[] | undefined;

/** Identifica o teste mais recente; respostas de testes anteriores são ignoradas. */
let testRun = 0;

function populateLanguages(select: HTMLSelectElement): void {
  for (const language of LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  }
}

function fillForm(settings: Readonly<TranslationSettings>): void {
  const endpointChanged = endpointInput.value !== settings.endpoint;
  endpointInput.value = settings.endpoint;
  modelInput.value = settings.model;
  sourceSelect.value = settings.sourceLanguage;
  targetSelect.value = settings.targetLanguage;
  if (endpointChanged) resetConnection();
  else syncModelChoice();
}

function announceTo(region: HTMLElement, message: string): void {
  // Limpa antes de escrever para que leitores de tela anunciem mensagens repetidas.
  region.textContent = '';
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}

function announce(message: string): void {
  announceTo(feedback, message);
}

/**
 * Sincroniza a lista de instalados e o aviso com o texto do campo Modelo,
 * que é a fonte de verdade do que é salvo. O aviso não bloqueia o salvamento.
 */
function syncModelChoice(): void {
  const models = installedModels;
  const model = validateModel(modelInput.value);
  if (!models || !model.ok) {
    modelWarning.textContent = '';
    installedSelect.value = '';
    return;
  }
  installedSelect.value = models.find((name) => hasModel([name], model.value)) ?? '';
  modelWarning.textContent = hasModel(models, model.value) ? '' : missingModelMessage(model.value);
}

function renderInstalledModels(models: readonly string[]): void {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = INSTALLED_PLACEHOLDER;
  const options = models.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    return option;
  });
  installedSelect.replaceChildren(placeholder, ...options);
  // Sem modelos, uma lista só com o texto de escolha não ajuda; o aviso orienta.
  installedField.hidden = models.length === 0;
}

/** Descarta o resultado de um teste anterior (ex.: o endereço mudou). */
function resetConnection(): void {
  testRun += 1;
  installedModels = undefined;
  installedField.hidden = true;
  installedSelect.replaceChildren();
  modelWarning.textContent = '';
  connectionStatus.textContent = '';
}

function setEndpointError(message: string | undefined): void {
  errorElements.endpoint.textContent = message ?? '';
  if (message) endpointInput.setAttribute('aria-invalid', 'true');
  else endpointInput.removeAttribute('aria-invalid');
}

/**
 * Testa o endereço digitado (não o salvo). `userInitiated` controla o foco:
 * o teste automático ao abrir a página não deve mover o foco do usuário.
 */
async function testConnection(userInitiated: boolean): Promise<void> {
  const endpoint = normalizeEndpoint(endpointInput.value);
  resetConnection();
  if (!endpoint.ok) {
    setEndpointError(endpointErrorMessage(endpoint.reason));
    announceTo(connectionStatus, TEST_INVALID_MESSAGE);
    if (userInitiated) endpointInput.focus();
    return;
  }
  setEndpointError(undefined);

  const run = testRun;
  setTesting(true);
  announceTo(connectionStatus, TESTING_MESSAGE);
  try {
    // Arrow function: chamar `fetch` desacoplado de `window` gera "Illegal invocation".
    const result = await listModels(endpoint.value, { fetchFn: (...args) => fetch(...args) });
    if (run !== testRun) return;
    if (result.ok) {
      installedModels = result.models;
      renderInstalledModels(result.models);
      syncModelChoice();
      announceTo(connectionStatus, connectedMessage(result.models.length));
      return;
    }
    announceTo(connectionStatus, ollamaErrorMessage(result.error, result.status));
    if (result.error === 'forbidden') {
      originHelp.hidden = false;
      if (userInitiated) originHelpTitle.focus();
    }
  } finally {
    setTesting(false);
  }
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
  testButton.addEventListener('click', () => {
    if (!testing) void testConnection(true);
  });
  endpointInput.addEventListener('input', resetConnection);
  modelInput.addEventListener('input', syncModelChoice);
  installedSelect.addEventListener('change', () => {
    if (installedSelect.value === '') return;
    modelInput.value = installedSelect.value;
    errorElements.model.textContent = '';
    modelInput.removeAttribute('aria-invalid');
    syncModelChoice();
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

  // Teste automático com o endereço carregado: só vai ao loopback, sem dados
  // da página, e mostra de imediato a lista de modelos ou o motivo da falha.
  setTesting(false);
  await testConnection(false);
}

void init();

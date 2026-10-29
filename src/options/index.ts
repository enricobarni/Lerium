import { DEFAULT_SETTINGS, LANGUAGES } from '../core/constants';
import { DEFAULT_LIST_MODELS_TIMEOUT_MS, hasModel } from '../core/ollama-client';
import type { TranslationSettings } from '../core/types';
import {
  TEST_CONNECTION_MESSAGE_TYPE,
  parseTestConnectionResponse,
  type TestConnectionRequest,
  type TestConnectionResponse,
} from '../shared/runtime-messages';
import { normalizeEndpoint, validateModel } from '../shared/validation';
import { createSettingsRepository, type SettingsFieldErrors } from '../storage/settings-repository';
import {
  connectedMessage,
  connectionErrorMessage,
  endpointErrorMessage,
  extensionOrigin,
  languageErrorMessage,
  missingModelMessage,
  modelErrorMessage,
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
const TEST_INVALID_MODEL_MESSAGE = 'Corrija o nome do modelo para testar a conexão.';
const INSTALLED_PLACEHOLDER = 'Escolha um modelo instalado';
const COPIED_MESSAGE = 'Origem copiada. Cole-a no valor de OLLAMA_ORIGINS.';
const COPY_ERROR =
  'Não foi possível copiar automaticamente. Selecione a origem acima e copie com Ctrl+C.';

/**
 * Prazo da resposta do service worker: as duas requisições do teste
 * (`/api/tags` e `/api/show`) têm prazo próprio no worker; a folga cobre o
 * acordar do worker. Estourado, o worker não respondeu.
 */
const WORKER_TIMEOUT_MS = DEFAULT_LIST_MODELS_TIMEOUT_MS * 2 + 2000;

type ConnectionResult = TestConnectionResponse | { ok: false; error: 'extension_error' };

const EXTENSION_ERROR: ConnectionResult = Object.freeze({ ok: false, error: 'extension_error' });

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
const originHelpTitle = byId('origin-help-title', HTMLHeadingElement);
const originCode = byId('extension-origin', HTMLElement);
const copyButton = byId('copy-origin', HTMLButtonElement);
const copyStatus = byId('copy-status', HTMLParagraphElement);

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

/** Modelo verificado por `/api/show` no último teste bem-sucedido. */
let testedModel: { name: string; installed: boolean } | undefined;

/** Identifica o teste mais recente; respostas de testes anteriores são ignoradas. */
let testRun = 0;

/** Há um teste de conexão vigente (não obsoleto) aguardando resposta. */
let testInFlight = false;

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
  // `/api/show` é a fonte mais fiel para o modelo testado; os demais usam a lista.
  const installed =
    testedModel?.name === model.value ? testedModel.installed : hasModel(models, model.value);
  modelWarning.textContent = installed ? '' : missingModelMessage(model.value);
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
  // O teste em andamento ficou obsoleto: libera o botão já, sem esperar a resposta.
  if (testInFlight) {
    testInFlight = false;
    setTesting(false);
  }
  installedModels = undefined;
  testedModel = undefined;
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

function setModelError(message: string | undefined): void {
  errorElements.model.textContent = message ?? '';
  if (message) modelInput.setAttribute('aria-invalid', 'true');
  else modelInput.removeAttribute('aria-invalid');
}

/**
 * Pede o teste ao service worker, único cliente HTTP do Ollama (ADR-009).
 * Nunca lança: worker ausente ("Receiving end does not exist"), prazo
 * estourado ou resposta fora do contrato viram `extension_error`.
 */
async function requestConnectionTest(endpoint: string, model: string): Promise<ConnectionResult> {
  const request: TestConnectionRequest = { type: TEST_CONNECTION_MESSAGE_TYPE, endpoint, model };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), WORKER_TIMEOUT_MS);
  });
  try {
    const raw: unknown = await Promise.race([chrome.runtime.sendMessage(request), deadline]);
    return parseTestConnectionResponse(raw) ?? EXTENSION_ERROR;
  } catch {
    return EXTENSION_ERROR;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Testa o endereço e o modelo digitados (não os salvos). `userInitiated` controla o foco:
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
  const model = validateModel(modelInput.value);
  if (!model.ok) {
    setModelError(modelErrorMessage(model.reason));
    announceTo(connectionStatus, TEST_INVALID_MODEL_MESSAGE);
    if (userInitiated) modelInput.focus();
    return;
  }
  setModelError(undefined);

  const run = testRun;
  testInFlight = true;
  setTesting(true);
  announceTo(connectionStatus, TESTING_MESSAGE);
  try {
    const result = await requestConnectionTest(endpoint.value, model.value);
    if (run !== testRun) return;
    if (result.ok) {
      installedModels = result.models;
      testedModel = { name: model.value, installed: result.modelInstalled };
      renderInstalledModels(result.models);
      syncModelChoice();
      announceTo(connectionStatus, connectedMessage(result.models.length));
      return;
    }
    announceTo(
      connectionStatus,
      connectionErrorMessage(result.error, 'status' in result ? result.status : undefined),
    );
    // A seção de liberação da origem está sempre visível; no teste manual,
    // levar o foco até ela encurta o caminho até a solução.
    if (result.error === 'forbidden' && userInitiated) originHelpTitle.focus();
  } finally {
    // Um teste obsoleto não mexe no botão de um teste mais novo.
    if (run === testRun) {
      testInFlight = false;
      setTesting(false);
    }
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

async function copyOrigin(origin: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(origin);
    announceTo(copyStatus, COPIED_MESSAGE);
  } catch {
    announceTo(copyStatus, COPY_ERROR);
  }
}

async function init(): Promise<void> {
  // Calculada em runtime: o ID vem da `key` do manifesto (ADR-007).
  const origin = extensionOrigin(chrome.runtime.id);
  originCode.textContent = origin;
  copyButton.addEventListener('click', () => void copyOrigin(origin));

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
    setModelError(undefined);
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

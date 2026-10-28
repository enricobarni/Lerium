const OPEN_OPTIONS_ERROR = 'Não foi possível abrir as configurações. Tente novamente.';

const openOptionsButton = document.getElementById('open-options');
const statusMessage = document.getElementById('status');

async function openOptions(): Promise<void> {
  try {
    await chrome.runtime.openOptionsPage();
    // A aba de configurações recebe o foco; fechar o popup evita deixá-lo aberto por trás dela.
    window.close();
  } catch {
    // Sem registrar detalhes do erro: a mensagem ao usuário basta nesta fase.
    if (statusMessage) {
      statusMessage.textContent = OPEN_OPTIONS_ERROR;
    }
  }
}

if (openOptionsButton instanceof HTMLButtonElement) {
  openOptionsButton.addEventListener('click', () => {
    void openOptions();
  });
}

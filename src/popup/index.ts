const OPEN_OPTIONS_ERROR = 'Não foi possível abrir as configurações. Tente novamente.';

const openOptionsButton = document.getElementById('open-options');
const feedback = document.getElementById('feedback');

async function openOptions(): Promise<void> {
  try {
    await chrome.runtime.openOptionsPage();
    // A aba de configurações recebe o foco; fechar o popup evita deixá-lo aberto por trás dela.
    window.close();
  } catch {
    // Sem registrar detalhes do erro: a mensagem ao usuário basta nesta fase.
    if (feedback) {
      // Limpa antes de escrever para que leitores de tela anunciem o erro mesmo se ele se repetir.
      feedback.textContent = '';
      requestAnimationFrame(() => {
        feedback.textContent = OPEN_OPTIONS_ERROR;
      });
    }
  }
}

if (openOptionsButton instanceof HTMLButtonElement) {
  openOptionsButton.addEventListener('click', () => {
    void openOptions();
  });
}

/**
 * Restrição de acesso a uma área de storage (`chrome.storage.*`). Módulo
 * puro: a área entra por injeção, para ser testável sem `chrome`.
 *
 * Por padrão, `chrome.storage.local` é acessível também a content scripts,
 * que rodam dentro de páginas web não confiáveis. O Lerium só lê e grava
 * preferências em páginas da extensão e no service worker; o content script
 * recebe tudo pelo worker. Restringir a `TRUSTED_CONTEXTS` reduz o que um
 * content script comprometido conseguiria ler ou alterar.
 */

export const TRUSTED_CONTEXTS = 'TRUSTED_CONTEXTS';

/** Subconjunto de `chrome.storage.StorageArea` usado aqui. */
export interface AccessLevelArea {
  setAccessLevel?: (options: { accessLevel: typeof TRUSTED_CONTEXTS }) => Promise<void>;
}

/**
 * Pede ao Chrome para expor a área só a contextos confiáveis. Melhor
 * esforço: se a API não existir ou recusar (Chrome sem suporte para a
 * área), não faz nada e nunca lança. Devolve se a restrição foi aplicada.
 */
export async function restrictToTrustedContexts(area: AccessLevelArea): Promise<boolean> {
  if (typeof area.setAccessLevel !== 'function') return false;
  try {
    await area.setAccessLevel({ accessLevel: TRUSTED_CONTEXTS });
    return true;
  } catch {
    return false;
  }
}

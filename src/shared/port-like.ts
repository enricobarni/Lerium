/**
 * Subconjunto de `chrome.runtime.Port` usado pelo job de página (ADR-010).
 * Os módulos do service worker e do content script dependem só desta
 * interface, para que os testes injetem uma porta falsa sem `chrome`.
 */
export interface PortSenderLike {
  readonly id?: string;
  readonly url?: string;
  readonly frameId?: number;
  readonly documentId?: string;
  readonly tab?: { readonly id?: number };
}

export interface PortEventLike<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface PortLike {
  readonly name: string;
  readonly sender?: PortSenderLike;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: PortEventLike<(message: unknown) => void>;
  readonly onDisconnect: PortEventLike<() => void>;
}

import { describe, expect, it } from 'vitest';
import { describeProgress } from '../../src/content/progress-view';
import type {
  PageStateError,
  PageStateView,
  PageStatus,
  PageView,
} from '../../src/shared/page-control';
import {
  NO_TEXT_MESSAGE,
  NOTHING_TRANSLATED_MESSAGE,
  partialMessage,
  STATE_ERROR_MESSAGES,
  TRANSLATED_MESSAGE,
  TRANSLATING_ANNOUNCE,
  translatingMessage,
} from '../../src/shared/page-status-text';
import * as popupView from '../../src/popup/page-view';

const STATUSES: PageStatus[] = ['idle', 'translating', 'translated', 'cancelled', 'error'];
const VIEWS: PageView[] = ['original', 'translation'];
const STATE_ERRORS: PageStateError[] = [
  'network',
  'forbidden',
  'model_missing',
  'invalid_config',
  'settings_unavailable',
  'interrupted',
];

const state = (overrides: Partial<PageStateView> = {}): PageStateView => ({
  status: 'idle',
  view: 'translation',
  total: 0,
  done: 0,
  failed: 0,
  skipped: 0,
  ...overrides,
});

describe('describeProgress: oculto', () => {
  it.each(VIEWS)('idle (%s) → null', (view) => {
    expect(describeProgress(state({ status: 'idle', view }))).toBeNull();
  });

  it.each(VIEWS)('cancelled (%s) → null, mesmo com tradução aplicada', (view) => {
    expect(describeProgress(state({ status: 'cancelled', view, total: 4, done: 2 }))).toBeNull();
  });

  it.each(STATUSES)('view original com %s → null', (status) => {
    expect(
      describeProgress(
        state({ status, view: 'original', total: 3, done: 1, failed: 1, error: 'network' }),
      ),
    ).toBeNull();
  });
});

describe('describeProgress: traduzindo', () => {
  it('mostra a contagem e a barra; o anúncio não tem contagem', () => {
    expect(describeProgress(state({ status: 'translating', total: 10, done: 3 }))).toEqual({
      message: translatingMessage(3, 10),
      announce: TRANSLATING_ANNOUNCE,
      tone: 'info',
      progress: { value: 3, max: 10 },
      autoHide: false,
    });
  });

  it('conta falhas e pulados como processados', () => {
    const view = describeProgress(
      state({ status: 'translating', total: 10, done: 2, failed: 1, skipped: 3 }),
    );
    expect(view?.progress).toEqual({ value: 6, max: 10 });
    expect(view?.message).toBe('Traduzindo… 6 de 10 trechos.');
  });

  it('limita o processado ao total', () => {
    const view = describeProgress(
      state({ status: 'translating', total: 2, done: 2, failed: 1, skipped: 1 }),
    );
    expect(view?.progress).toEqual({ value: 2, max: 2 });
  });

  it('total 1 usa singular', () => {
    expect(describeProgress(state({ status: 'translating', total: 1 }))?.message).toBe(
      'Traduzindo… 0 de 1 trecho.',
    );
  });

  it('sem total: só a mensagem, sem barra', () => {
    const view = describeProgress(state({ status: 'translating', total: 0 }));
    expect(view).toEqual({
      message: 'Traduzindo…',
      announce: TRANSLATING_ANNOUNCE,
      tone: 'info',
      autoHide: false,
    });
    expect(view).not.toHaveProperty('progress');
  });

  it('o anúncio é o mesmo em todo o progresso', () => {
    const announces = new Set(
      [0, 1, 5, 9, 10].map(
        (done) => describeProgress(state({ status: 'translating', total: 10, done }))?.announce,
      ),
    );
    expect([...announces]).toEqual([TRANSLATING_ANNOUNCE]);
  });
});

describe('describeProgress: concluído', () => {
  it('completo: sucesso que some sozinho', () => {
    expect(describeProgress(state({ status: 'translated', total: 5, done: 5 }))).toEqual({
      message: TRANSLATED_MESSAGE,
      announce: TRANSLATED_MESSAGE,
      tone: 'success',
      autoHide: true,
    });
  });

  it.each([
    [1, 0, 1],
    [0, 1, 1],
    [2, 3, 5],
  ])('parcial (falhas %i, pulados %i): aviso que fica', (failed, skipped, untranslated) => {
    expect(
      describeProgress(state({ status: 'translated', total: 10, done: 4, failed, skipped })),
    ).toEqual({
      message: partialMessage(untranslated),
      announce: partialMessage(untranslated),
      tone: 'warning',
      autoHide: false,
    });
  });

  it('sem texto na página: aviso que fica', () => {
    expect(describeProgress(state({ status: 'translated', total: 0 }))).toEqual({
      message: NO_TEXT_MESSAGE,
      announce: NO_TEXT_MESSAGE,
      tone: 'warning',
      autoHide: false,
    });
  });

  it('nada traduzido: aviso que fica', () => {
    expect(
      describeProgress(state({ status: 'translated', total: 3, done: 0, failed: 2, skipped: 1 })),
    ).toEqual({
      message: NOTHING_TRANSLATED_MESSAGE,
      announce: NOTHING_TRANSLATED_MESSAGE,
      tone: 'warning',
      autoHide: false,
    });
  });

  it('nunca há barra fora de translating', () => {
    for (const status of STATUSES) {
      if (status === 'translating') continue;
      const view = describeProgress(state({ status, total: 4, done: 2 }));
      expect(view?.progress).toBeUndefined();
    }
  });
});

describe('describeProgress: erro', () => {
  it.each(STATE_ERRORS)('%s: mensagem do popup, sem sumir', (error) => {
    expect(describeProgress(state({ status: 'error', error, total: 4, done: 1 }))).toEqual({
      message: STATE_ERROR_MESSAGES[error],
      announce: STATE_ERROR_MESSAGES[error],
      tone: 'error',
      autoHide: false,
    });
  });

  it('erro sem código vale como interrompido', () => {
    expect(describeProgress(state({ status: 'error' }))?.message).toBe(
      STATE_ERROR_MESSAGES.interrupted,
    );
  });

  it('a mensagem é a mesma do popup para o mesmo estado', () => {
    for (const error of STATE_ERRORS) {
      const input = state({ status: 'error', error });
      expect(describeProgress(input)?.message).toBe(
        popupView.describePage({ kind: 'state', state: input }).message,
      );
    }
  });
});

describe('describeProgress: nenhum texto da página', () => {
  it('toda mensagem vem do conjunto fixo, com só contagens variando', () => {
    const fixed = new Set<string>([
      TRANSLATED_MESSAGE,
      NO_TEXT_MESSAGE,
      NOTHING_TRANSLATED_MESSAGE,
      TRANSLATING_ANNOUNCE,
      ...Object.values(STATE_ERROR_MESSAGES),
    ]);
    const counted =
      /^(Traduzindo…( \d+ de \d+ trechos?\.)?|Página traduzida\. (1 trecho continua|\d+ trechos continuam) no original\.)$/;
    for (const status of STATUSES) {
      for (const view of VIEWS) {
        for (const error of [undefined, ...STATE_ERRORS]) {
          for (const [total, done, failed, skipped] of [
            [0, 0, 0, 0],
            [3, 3, 0, 0],
            [3, 1, 1, 1],
            [3, 0, 3, 0],
          ] as const) {
            const view_ = describeProgress(
              state({
                status,
                view,
                total,
                done,
                failed,
                skipped,
                ...(error === undefined ? {} : { error }),
              }),
            );
            if (view_ === null) continue;
            for (const text of [view_.message, view_.announce]) {
              expect(fixed.has(text) || counted.test(text)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('não copia campos extras do estado', () => {
    const input = { ...state({ status: 'translated', total: 1, done: 1 }), title: 'Capítulo 1' };
    const view = describeProgress(input);
    expect(Object.keys(view ?? {}).sort()).toEqual(['announce', 'autoHide', 'message', 'tone']);
  });
});

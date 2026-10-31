import { describe, expect, it, vi } from 'vitest';
import { restrictToTrustedContexts } from '../../src/storage/storage-access';

describe('restrictToTrustedContexts', () => {
  it('pede TRUSTED_CONTEXTS à área', async () => {
    const setAccessLevel = vi.fn(async () => {});

    await expect(restrictToTrustedContexts({ setAccessLevel })).resolves.toBe(true);
    expect(setAccessLevel).toHaveBeenCalledExactlyOnceWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('sem a API não faz nada', async () => {
    await expect(restrictToTrustedContexts({})).resolves.toBe(false);
  });

  it('rejeição do Chrome é engolida', async () => {
    const setAccessLevel = vi.fn(async () => {
      throw new Error('This StorageArea does not support setAccessLevel');
    });

    await expect(restrictToTrustedContexts({ setAccessLevel })).resolves.toBe(false);
  });

  it('erro síncrono também é engolido', async () => {
    const setAccessLevel = vi.fn((): Promise<void> => {
      throw new Error('sync');
    });

    await expect(restrictToTrustedContexts({ setAccessLevel })).resolves.toBe(false);
  });
});

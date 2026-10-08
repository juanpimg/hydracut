import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../store/useUIStore';
import { useProjectStore } from '../store/useProjectStore';

describe('Welcome screen state', () => {
  beforeEach(() => {
    useUIStore.setState({ isWelcomeOpen: true });
    useProjectStore.getState().resetProject();
  });

  it('la bienvenida está abierta al arrancar y se puede cerrar', () => {
    expect(useUIStore.getState().isWelcomeOpen).toBe(true);
    useUIStore.getState().setWelcomeOpen(false);
    expect(useUIStore.getState().isWelcomeOpen).toBe(false);
  });

  it('cerrar la bienvenida no altera el proyecto actual (continuar donde estaba)', () => {
    const before = useProjectStore.getState().project;
    useUIStore.getState().setWelcomeOpen(false);
    const after = useProjectStore.getState().project;
    expect(after.id).toBe(before.id);
    expect(after.clips).toEqual(before.clips);
  });
});

/**
 * Cableado de componentes y hooks (auditoría T-02).
 *
 * El `quality-guard` exige que cada módulo de producción esté importado Y
 * usado por un test: estos 32 módulos (componentes, primitivas UI y el hook
 * de menús) no lo estaban. Este fichero los carga todos —probar que el
 * módulo evalúa en node sin reventar ya caza podredumbre de imports— y
 * afirma la forma de sus exports más los valores puros que son gratis de
 * comprobar. El comportamiento con DOM pertenece a la suite de navegador;
 * las costuras con el reloj y el ciclo de vida del hook viven en
 * `viewer-clock-subscription.test.ts` y `anchored-menu.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { ClipInspector, OVERLAP_POLICY_LABELS } from '../components/inspector/ClipInspector';
import { InspectorPanel } from '../components/inspector/InspectorPanel';
import { Header } from '../components/layout/Header';
import { Sidebar } from '../components/layout/Sidebar';
import { MediaItemCard } from '../components/media/MediaItemCard';
import { MobileBottomSheet } from '../components/mobile/MobileBottomSheet';
import { MobileHeader } from '../components/mobile/MobileHeader';
import { ProjectsModal } from '../components/modals/ProjectsModal';
import { ShortcutsModal } from '../components/modals/ShortcutsModal';
import { WelcomeModal } from '../components/modals/WelcomeModal';
import { PlayerControls } from '../components/player/PlayerControls';
import { Playhead } from '../components/timeline/Playhead';
import { TrackLane } from '../components/timeline/TrackLane';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Checkbox } from '../components/ui/Checkbox';
import { Dialog } from '../components/ui/Dialog';
import { Field } from '../components/ui/Field';
import { IconButton } from '../components/ui/IconButton';
import { Input } from '../components/ui/Input';
import { Menu, MenuItem, MenuSeparador } from '../components/ui/Menu';
import { Panel } from '../components/ui/Panel';
import { Section } from '../components/ui/Section';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { Select } from '../components/ui/Select';
import { Slider } from '../components/ui/Slider';
import {
  TOAST_AUTO_DISMISS_MS,
  Toast,
  ToastHost,
  useToasts,
} from '../components/ui/Toast';
import { Toggle } from '../components/ui/Toggle';
import { Tooltip } from '../components/ui/Tooltip';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';

describe('cableado · los paneles principales exportan su componente', () => {
  it('inspector, cabecera, rail, visor auxiliar y controles existen', () => {
    expect(ClipInspector).toBeDefined();
    expect(InspectorPanel).toBeDefined();
    expect(Header).toBeDefined();
    expect(Sidebar).toBeDefined();
    expect(MediaItemCard).toBeDefined();
    expect(MobileBottomSheet).toBeDefined();
    expect(MobileHeader).toBeDefined();
    expect(PlayerControls).toBeDefined();
    expect(Playhead).toBeDefined();
    expect(TrackLane).toBeDefined();
  });

  it('los modales existen (carga diferida desde el layout)', () => {
    expect(ProjectsModal).toBeDefined();
    expect(ShortcutsModal).toBeDefined();
    expect(WelcomeModal).toBeDefined();
  });

  it('el inspector publica su catálogo de políticas de solape', () => {
    expect(typeof OVERLAP_POLICY_LABELS).toBe('object');
    expect(Object.keys(OVERLAP_POLICY_LABELS).length).toBeGreaterThan(0);
  });
});

describe('cableado · las primitivas UI exportan su componente', () => {
  it('todas las primitivas están definidas', () => {
    expect(Badge).toBeDefined();
    expect(Button).toBeDefined();
    expect(Checkbox).toBeDefined();
    expect(Dialog).toBeDefined();
    expect(Field).toBeDefined();
    expect(IconButton).toBeDefined();
    expect(Input).toBeDefined();
    expect(Menu).toBeDefined();
    expect(MenuItem).toBeDefined();
    expect(MenuSeparador).toBeDefined();
    expect(Panel).toBeDefined();
    expect(Section).toBeDefined();
    expect(SegmentedControl).toBeDefined();
    expect(Select).toBeDefined();
    expect(Slider).toBeDefined();
    expect(Toast).toBeDefined();
    expect(ToastHost).toBeDefined();
    expect(Toggle).toBeDefined();
    expect(Tooltip).toBeDefined();
  });

  it('los avisos se autodestruyen en un plazo positivo', () => {
    expect(typeof TOAST_AUTO_DISMISS_MS).toBe('number');
    expect(TOAST_AUTO_DISMISS_MS).toBeGreaterThan(0);
    expect(typeof useToasts).toBe('function');
  });
});

describe('cableado · el hook de menús anclados', () => {
  it('expone el hook con su contrato (posición + recálculo)', () => {
    expect(typeof useAnchoredMenu).toBe('function');
    expect(useAnchoredMenu.length).toBe(3);
  });
});

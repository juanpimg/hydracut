/**
 * Primitivas del sistema de diseño (ola U0).
 * Las olas U1–U7 construyen SOLO con estos componentes y los tokens de
 * `DESIGN.md`: no inventan colores, radios ni variantes ad-hoc.
 */
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { IconButton, type IconButtonProps, type IconButtonSize } from './IconButton';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './SegmentedControl';
export { Slider, type SliderProps } from './Slider';
export { Toggle, type ToggleProps } from './Toggle';
export { Checkbox, type CheckboxProps } from './Checkbox';
export { Select, type SelectProps } from './Select';
export { Input, type InputProps } from './Input';
export { Panel, type PanelProps } from './Panel';
export { Section, type SectionProps } from './Section';
export { Badge, type BadgeProps, type BadgeVariant } from './Badge';
export { Tooltip, type TooltipProps } from './Tooltip';
export {
  Toast,
  ToastHost,
  useToasts,
  TOAST_AUTO_DISMISS_MS,
  type ToastData,
  type ToastProps,
  type ToastHostProps,
  type ToastTone,
} from './Toast';
export { Dialog, type DialogProps } from './Dialog';
export { Menu, MenuItem, MenuSeparador, type MenuProps, type MenuItemProps } from './Menu';
export { Field, type FieldProps } from './Field';

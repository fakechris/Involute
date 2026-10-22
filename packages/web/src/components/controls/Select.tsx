import type { Ref, SelectHTMLAttributes } from 'react';

import { useFieldControl } from './Field';
import { controlClass, type ControlSize } from './TextInput';

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** `default`: bordered control. `ghost`: borderless until hovered (property rows; was `.issue-panel__prop-select`). */
  variant?: 'default' | 'ghost' | undefined;
  size?: ControlSize | undefined;
  ref?: Ref<HTMLSelectElement> | undefined;
}

/**
 * The only place a native select element is rendered (docs/design-system.md §3.3):
 * `appearance: none` with a drawn chevron, so every select looks the same in
 * both themes. Behaviour is the native element's.
 */
export function Select({ variant = 'default', size, className, ref, children, ...rest }: SelectProps) {
  const { id, describedBy, invalid } = useFieldControl(rest);
  return (
    <select
      {...rest}
      ref={ref}
      id={id}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      className={controlClass('control-select', size, variant === 'ghost' ? 'control--ghost' : undefined, className)}
    >
      {children}
    </select>
  );
}

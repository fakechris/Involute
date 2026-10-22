import type { InputHTMLAttributes, Ref } from 'react';

import { useFieldControl } from './Field';

export type ControlSize = 'sm' | 'md';

export function controlClass(base: string, size: ControlSize | undefined, extra?: string, className?: string): string {
  return ['control', base, size === 'sm' ? 'control--sm' : null, extra, className].filter(Boolean).join(' ');
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** `md` 30px (default); `sm` 26px for dense rows. */
  size?: ControlSize;
  ref?: Ref<HTMLInputElement>;
}

/** A single-line input on the shared `.control` base (docs/design-system.md §3.3). */
export function TextInput({ size, className, type = 'text', ref, ...rest }: TextInputProps) {
  const { id, describedBy, invalid } = useFieldControl(rest);
  return (
    <input
      {...rest}
      ref={ref}
      type={type}
      id={id}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      className={controlClass('control-input', size, undefined, className)}
    />
  );
}

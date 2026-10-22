import type { InputHTMLAttributes, ReactNode, Ref } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Text beside the box; the whole row is the click target. */
  label?: ReactNode | undefined;
  ref?: Ref<HTMLInputElement> | undefined;
}

/** A checkbox with its label on one row, tinted with the accent colour. */
export function Checkbox({ label, className, ref, ...rest }: CheckboxProps) {
  const input = <input {...rest} ref={ref} type="checkbox" className={label === undefined ? ['checkbox__input', className].filter(Boolean).join(' ') : 'checkbox__input'} />;
  if (label === undefined) {
    return input;
  }
  return (
    <label className={['checkbox', rest.disabled ? 'checkbox--disabled' : null, className].filter(Boolean).join(' ')}>
      {input}
      <span className="checkbox__label">{label}</span>
    </label>
  );
}

import type { Ref, TextareaHTMLAttributes } from 'react';

import { useFieldControl } from './Field';
import { controlClass, type ControlSize } from './TextInput';

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: ControlSize | undefined;
  ref?: Ref<HTMLTextAreaElement> | undefined;
}

/** A multi-line input on the shared `.control` base; resizes vertically. */
export function TextArea({ size, className, ref, ...rest }: TextAreaProps) {
  const { id, describedBy, invalid } = useFieldControl(rest);
  return (
    <textarea
      {...rest}
      ref={ref}
      id={id}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      className={controlClass('control-textarea', size, undefined, className)}
    />
  );
}

import { createContext, useContext, useId, type ReactNode } from 'react';

/**
 * Wiring a Field hands to the control inside it: the id its label points at
 * and the ids that describe it (hint, error). Controls read it when they are
 * not given an explicit id.
 */
interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldControl(props: { id?: string | undefined; 'aria-describedby'?: string | undefined; 'aria-invalid'?: unknown }) {
  const field = useContext(FieldContext);
  const describedBy = [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined;
  const invalid = props['aria-invalid'] ?? (field?.invalid ? true : undefined);
  return { id: props.id ?? field?.id, describedBy, invalid: invalid as boolean | 'true' | 'false' | undefined };
}

export interface FieldProps {
  label: ReactNode;
  /** The control's id; generated when omitted and handed to the control inside. */
  htmlFor?: string | undefined;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  /** `stack`: label above (default). `aside`: label and hint in a 180px column (settings rows). */
  layout?: 'stack' | 'aside' | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * A label (sentence case, 12px, --fg-dim), the control, an optional hint and an
 * optional error (docs/design-system.md §3.3). The only label idiom for forms.
 */
export function Field({ label, htmlFor, hint, error, layout = 'stack', className, children }: FieldProps) {
  const generatedId = useId();
  const id = htmlFor ?? `field-${generatedId}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const classes = ['field', layout === 'aside' ? 'field--aside' : null, className].filter(Boolean).join(' ');

  const labelNode = <label className="field__label" htmlFor={id}>{label}</label>;
  const hintNode = hint ? <span className="field__hint" id={hintId}>{hint}</span> : null;
  const errorNode = error ? <span className="field__error" id={errorId} role="alert">{error}</span> : null;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      {layout === 'aside' ? (
        <div className={classes}>
          <div className="field__aside">
            {labelNode}
            {hintNode}
          </div>
          <div className="field__control">
            {children}
            {errorNode}
          </div>
        </div>
      ) : (
        <div className={classes}>
          {labelNode}
          {children}
          {hintNode}
          {errorNode}
        </div>
      )}
    </FieldContext.Provider>
  );
}

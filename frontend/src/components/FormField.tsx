import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

interface FormFieldProps {
  /** id of the control inside; the label and the error point to it. */
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

/** Label, control and validation message. The control should set `aria-invalid` and `aria-describedby="<id>-message"`. */
export function FormField({ id, label, error, hint, children }: FormFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-message`} className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-message`} className="text-sm text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

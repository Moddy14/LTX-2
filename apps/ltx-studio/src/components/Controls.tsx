import { Eye, EyeOff, Info } from "lucide-react";
import { type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, useId, useState } from "react";

export function InfoTooltip({ text }: { text: string }) {
  const tooltipId = useId();
  return (
    <span
      className="tooltip"
      tabIndex={0}
      aria-label={`Feldhilfe: ${text}`}
      aria-describedby={tooltipId}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Info size={14} aria-hidden="true" />
      <span id={tooltipId} className="tooltip__content" role="tooltip">
        {text}
      </span>
    </span>
  );
}

type FieldProps = {
  label: string;
  hint: string;
  error?: string;
  children: ReactNode;
  className?: string;
};

export function Field({ label, hint, error, children, className = "" }: FieldProps) {
  return (
    <label className={`field ${error ? "field--error" : ""} ${className}`}>
      <span className="field__label">
        {label}
        <InfoTooltip text={hint} />
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : null}
    </label>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  label: string;
  hint: string;
  error?: string;
  onChange: (value: string) => void;
  concealed?: boolean;
};

export function TextField({ label, hint, error, onChange, concealed = false, ...props }: TextFieldProps) {
  const [visible, setVisible] = useState(!concealed);
  return (
    <Field label={label} hint={hint} error={error}>
      <span className="input-shell">
        <input
          {...props}
          type={visible ? "text" : "password"}
          aria-label={props["aria-label"] ?? label}
          onChange={(event) => onChange(event.target.value)}
        />
        {concealed ? (
          <button
            type="button"
            className="icon-button icon-button--inside"
            onClick={() => setVisible((value) => !value)}
            title={visible ? "Pfad verbergen" : "Pfad anzeigen"}
          >
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        ) : null}
      </span>
    </Field>
  );
}

type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  label: string;
  hint: string;
  error?: string;
  value: number | null;
  onChange: (value: number | null) => void;
};

export function NumberField({ label, hint, error, value, onChange, ...props }: NumberFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      <input
        {...props}
        type="number"
        aria-label={props["aria-label"] ?? label}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      />
    </Field>
  );
}

type SelectFieldProps<T extends string> = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value"> & {
  label: string;
  hint: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
};

export function SelectField<T extends string>({ label, hint, value, options, onChange, ...props }: SelectFieldProps<T>) {
  return (
    <Field label={label} hint={hint}>
      <select
        {...props}
        value={value}
        aria-label={props["aria-label"] ?? label}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  );
}

export type PathOption = { path: string; label: string };

export function PathPicker({
  label,
  hint,
  value,
  options,
  error,
  placeholder,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  options: readonly PathOption[];
  error?: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const selected = options.some((option) => option.path === value) ? value : "__manual";
  return (
    <Field label={label} hint={hint} error={error} className="path-picker">
      <select
        aria-label={`${label} aus gefundenen Modellen auswählen`}
        value={selected}
        onChange={(event) => {
          if (event.target.value !== "__manual") onChange(event.target.value);
        }}
      >
        {options.map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
        <option value="__manual">Manueller DGX-Pfad</option>
      </select>
      <input
        aria-label={`${label} Pfad`}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

type ToggleProps = {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint: string;
  disabled?: boolean;
};

export function Toggle({ label, checked, onChange, hint, disabled = false }: ToggleProps) {
  const id = useId();
  return (
    <label className={`toggle ${disabled ? "toggle--disabled" : ""}`} htmlFor={id}>
      <span className="toggle__label">
        <strong>{label}</strong>
        <InfoTooltip text={hint} />
      </span>
      <input id={id} type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
    </label>
  );
}

type SegmentedProps<T extends string> = {
  label: string;
  hint: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
};

export function Segmented<T extends string>({ label, hint, value, options, onChange }: SegmentedProps<T>) {
  return (
    <fieldset className="segmented-field">
      <legend>{label}<InfoTooltip text={hint} /></legend>
      <div className="segmented">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={value === option.value ? "is-active" : ""}
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

import { createContext, useContext } from 'react';
import { messages } from './messages.ts';

export type Locale = 'en-CA' | 'fr-CA';
export const LocaleContext = createContext<Locale>('en-CA');
export function translate(
  locale: Locale,
  key: string,
  values: Record<string, string | number> = {},
) {
  const catalogue: Readonly<Record<string, string>> = messages[locale];
  const message = Object.hasOwn(catalogue, key) ? catalogue[key] : key;
  return message.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : token,
  );
}

export function useI18n() {
  const locale = useContext(LocaleContext);
  return {
    locale,
    t: (key: string, values?: Record<string, string | number>) => translate(locale, key, values),
    date: (value?: string, withTime = false) => formatDate(locale, value, withTime),
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, options).format(value),
    cad: (cents: number) =>
      new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' }).format(cents / 100),
  };
}

export function formatDate(locale: Locale, value?: string, withTime = false) {
  if (!value) return '—';
  if (!Number.isFinite(Date.parse(value))) return value;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    ...(withTime && !dateOnly && { timeStyle: 'short' }),
    timeZone: dateOnly ? 'UTC' : 'America/Toronto',
  }).format(new Date(value));
}

export function preferredLocale(): Locale {
  try {
    return localStorage.getItem('bs-platform-locale') === 'fr-CA' ? 'fr-CA' : 'en-CA';
  } catch {
    return 'en-CA';
  }
}

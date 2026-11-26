import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Card } from './components.tsx';
import { useI18n } from './i18n.tsx';
import { Form, TextField, field } from './screens/round-four.tsx';

export interface TenantBrand {
  productName: string;
  logoUrl: string;
  accent: string;
}

const storageKey = (tenantId: string) => 'bs-tenant-brand:' + tenantId;
const hex = /^#[0-9a-f]{6}$/i;
function safeLogo(value: string) {
  if (!value) return true;
  const url = URL.parse(value);
  return !!url && url.protocol === 'https:' && !url.username && !url.password;
}
function luminance(color: string) {
  const srgb = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
  const [r, g, b] = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function brandColors(accent: string, theme: 'light' | 'dark') {
  const text = contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : '#000000';
  const surface = theme === 'dark' ? '#21444a' : '#dcedef';
  // Tint used behind links and badges is the strictest background in each theme.
  const ink = contrast(accent, surface) >= 4.5 ? accent : theme === 'dark' ? '#ffffff' : '#000000';
  return { text, ink, ratio: contrast(accent, text) };
}
export function brandStyle(
  brand: TenantBrand | undefined,
  theme: 'light' | 'dark',
): CSSProperties | undefined {
  if (!brand) return undefined;
  const { text, ink } = brandColors(brand.accent, theme);
  return {
    '--bs-accent': brand.accent,
    '--bs-accent-hover': brand.accent,
    '--bs-accent-text': text,
    '--bs-accent-ink': ink,
  } as CSSProperties;
}
function validBrand(value: TenantBrand) {
  return (
    typeof value.productName === 'string' &&
    value.productName.trim().length > 0 &&
    value.productName.length <= 60 &&
    typeof value.accent === 'string' &&
    hex.test(value.accent) &&
    typeof value.logoUrl === 'string' &&
    value.logoUrl.length <= 2048 &&
    safeLogo(value.logoUrl)
  );
}
export function readBrand(tenantId: string): TenantBrand | undefined {
  try {
    const value: TenantBrand | null = JSON.parse(
      localStorage.getItem(storageKey(tenantId)) ?? 'null',
    );
    return value && validBrand(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
export function saveBrand(tenantId: string, brand: TenantBrand | undefined) {
  if (brand) localStorage.setItem(storageKey(tenantId), JSON.stringify(brand));
  else localStorage.removeItem(storageKey(tenantId));
}

export function BrandingEditor({
  brand,
  fallback,
  theme,
  onSave,
}: {
  brand?: TenantBrand;
  fallback: string;
  theme: 'light' | 'dark';
  onSave: (value?: TenantBrand) => boolean;
}) {
  const defaults: TenantBrand = { productName: fallback, logoUrl: '', accent: '#075f69' };
  const [draft, setDraft] = useState(brand ?? defaults);
  const { t, number } = useI18n();
  const colors = hex.test(draft.accent) ? brandColors(draft.accent, theme) : undefined;
  const accepted = validBrand(draft) && !!colors && colors.ratio >= 4.5;
  return (
    <Card title={t('Tenant branding')}>
      <Form
        onSubmit={(data) => {
          const value = {
            productName: field(data, 'name'),
            logoUrl: field(data, 'logo'),
            accent: field(data, 'accent'),
          };
          if (validBrand(value)) onSave(value);
        }}
      >
        <TextField
          label="Product name"
          name="name"
          maxLength={60}
          value={draft.productName}
          onChange={(event) => setDraft({ ...draft, productName: event.target.value })}
        />
        <TextField
          label="Logo URL"
          name="logo"
          type="url"
          required={false}
          maxLength={2048}
          value={draft.logoUrl}
          onChange={(event) => setDraft({ ...draft, logoUrl: event.target.value })}
        />
        <TextField
          label="Accent colour"
          name="accent"
          placeholder="#075f69"
          maxLength={7}
          value={draft.accent}
          onChange={(event) => setDraft({ ...draft, accent: event.target.value })}
        />
        <Button type="submit" disabled={!accepted}>
          {t('Save branding')}
        </Button>
        {brand && (
          <Button
            variant="secondary"
            onClick={() => {
              if (onSave(undefined)) setDraft(defaults);
            }}
          >
            {t('Restore default branding')}
          </Button>
        )}
      </Form>
      <p>{t('Brand preview')}</p>
      <div
        className="bs-brand-preview bs-inline"
        style={colors ? brandStyle(draft, theme) : undefined}
      >
        <BrandMark
          name={draft.productName || fallback}
          logoUrl={safeLogo(draft.logoUrl) ? draft.logoUrl : undefined}
          preview
        />
        <strong>{draft.productName || fallback}</strong>
        <span className="bs-button bs-button--primary">{t('Accent preview')}</span>
      </div>
      <p role="status">
        {colors
          ? t('Accent text contrast {ratio}:1 (minimum 4.5:1).', {
              ratio: number(colors.ratio, { maximumFractionDigits: 2 }),
            })
          : t('Enter a six-digit hex colour.')}
      </p>
      {!safeLogo(draft.logoUrl) && <p role="alert">{t('Enter an HTTPS logo URL.')}</p>}
    </Card>
  );
}

export function BrandMark({
  name,
  logoUrl,
  preview,
}: {
  name: string;
  logoUrl?: string;
  preview?: boolean;
}) {
  const [failed, setFailed] = useState('');
  return (
    <span className="bs-brand-mark" aria-hidden="true">
      {logoUrl && failed !== logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          referrerPolicy="no-referrer"
          loading={preview ? 'lazy' : undefined}
          onError={() => setFailed(logoUrl)}
        />
      ) : (
        name.trim()[0]?.toUpperCase()
      )}
    </span>
  );
}

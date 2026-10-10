/**
 * Computed styles of the picked element, from a fixed allowlist (INV-1147):
 * what a person needs to see a layout or typography bug, never anything the
 * page could use to carry data (content, custom properties, background images).
 */
export const STYLE_KEYS = [
  'font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color',
  'padding', 'margin', 'width', 'height', 'display', 'position', 'z-index', 'overflow',
] as const;

export type StyleKey = (typeof STYLE_KEYS)[number];
const STYLE_VALUE_LIMIT = 200;

/** Shorthands some engines leave empty in computed style: rebuild them from their sides. */
const SIDES: Partial<Record<StyleKey, string[]>> = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  overflow: ['overflow-x', 'overflow-y'],
};

export function extractStyles(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): Partial<Record<StyleKey, string>> {
  const styles: Partial<Record<StyleKey, string>> = {};
  for (const key of STYLE_KEYS) {
    let value = style.getPropertyValue(key).trim();
    const sides = SIDES[key];
    if (!value && sides) {
      const values = sides.map((side) => style.getPropertyValue(side).trim());
      if (values.every(Boolean)) value = values.every((entry) => entry === values[0]) ? values[0]! : values.join(' ');
    }
    if (value) styles[key] = value.length > STYLE_VALUE_LIMIT ? value.slice(0, STYLE_VALUE_LIMIT) : value;
  }
  return styles;
}

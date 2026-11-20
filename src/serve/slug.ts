/**
 * A skill's folder name from what the user typed: lowercase words and dashes. Letters with diacritics keep their base letter first
 * (Vietnamese "Tiếng Việt" → "tieng-viet", "Đà Nẵng" → "da-nang"; đ has no decomposition, so it is mapped by hand).
 */
export function skillSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

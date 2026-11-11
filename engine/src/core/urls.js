export function appUrl(path, options = {}) {
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL ?? '/';
  const documentBase =
    options.documentBase ?? globalThis.document?.baseURI ?? 'http://localhost/';
  const base = new URL(baseUrl, documentBase);
  const url = new URL(path.replace(/^\/+/, ''), base);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function presentationUrl(deckId, path = '', options = {}) {
  const suffix = path ? `/${path}` : '';
  return appUrl(`presentations/${deckId}${suffix}`, options);
}

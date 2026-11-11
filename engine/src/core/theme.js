export async function loadTheme(theme) { if (theme !== 'purple') throw Error('Unsupported public theme'); return import('../themes/purple/theme.css'); }
export function themeMeta(theme) { if (theme !== 'purple') throw Error('Unsupported public theme'); return { logo: new URL('../themes/purple/mark.svg', import.meta.url).href, brand: 'Presenter', website: 'example.org' }; }

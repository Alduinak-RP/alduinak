// Asset modules export the url as module.exports or as .default depending on the loader.
export const assetUrl = (mod: { default?: string } | string): string =>
  typeof mod === 'string' ? mod : mod.default || '';

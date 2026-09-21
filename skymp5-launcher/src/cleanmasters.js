'use strict'
// Simple Cleaned Masters: xdelta patches from the store masters to cleaned ones. Pure node so it stays headless-testable.

// Folder the standalone patcher keeps the original masters in, inside Data
const BACKUP_DIR = 'Original ESMs backups'

// Every size is unique per edition, so a file's size alone says which patch it takes or that it is already cleaned
const MASTERS = [
  { name: 'Update.esm', variants: [
    { edition: 'GOG',   srcSize: 18874185, dstSize: 17752650, patch: 'Update_GOG.vcdiff',   patchSha256: '06b541edb30db432e228a047862bfce8f2fe5ff67cf29b35a72662a34207656f', dstSha256: '655138032423ae6a9652ab5bfade2cb58bd2d1e9ed8012bad0133e021ba9ed0f' },
    { edition: 'Steam', srcSize: 18874041, dstSize: 17752506, patch: 'Update_Steam.vcdiff', patchSha256: 'd5cd9e32d77353af249b9e5ae13b22e557283229c6d12627583287e1316c106a' },
  ] },
  { name: 'Dawnguard.esm', variants: [
    { edition: 'GOG',   srcSize: 25885267, dstSize: 24469866, patch: 'Dawnguard_GOG.vcdiff',   patchSha256: '056da52435faa591f75595b240c649bec98fc5251b2abb74579eeff8fc14e732', dstSha256: 'a17408743060559823dcc958c9fe94c9e70b90fbe6ef474d420585878b8ff1a0' },
    { edition: 'Steam', srcSize: 25885111, dstSize: 24469710, patch: 'Dawnguard_Steam.vcdiff', patchSha256: '4db3d05112eb757345b9458c8f368688f9566bd1bf3c4376d32a4578b57ffd0a' },
  ] },
  { name: 'HearthFires.esm', variants: [
    { edition: 'GOG',   srcSize: 3978434, dstSize: 3652958, patch: 'HearthFires_GOG.vcdiff',   patchSha256: 'eb5a8db796e5f9b02703b093b861cdd0659f38de72d31a0327878d928a92c687', dstSha256: 'dcb2b593979a60b9ad511173d1ded23e4713d0287832492d5d4439d0383c7b29' },
    { edition: 'Steam', srcSize: 3977420, dstSize: 3651944, patch: 'HearthFires_Steam.vcdiff', patchSha256: '34c9cf0a87f18525374ea57a4962e46db072dbe29012beb43392ccab88092b80' },
  ] },
  { name: 'Dragonborn.esm', variants: [
    { edition: 'GOG',   srcSize: 64663894, dstSize: 64240276, patch: 'Dragonborn_GOG.vcdiff',   patchSha256: '3cac74263d7f3a2b9bdb31f5180f193c19f1fe58bd1bf6ddf58b50e2f031770d', dstSha256: 'df8ae7dc97ab8a453e2e083cc3cfcd1cb24ec42d14cd5b50e2df39e520b6f386' },
    { edition: 'Steam', srcSize: 64663863, dstSize: 64240244, patch: 'Dragonborn_Steam.vcdiff', patchSha256: '3383e0b564bf722e76a11f3a246f20937d736803c39a58e5c03419ac4fe94648' },
  ] },
  { name: 'ccBGSSSE001-Fish.esm', variants: [
    { edition: 'Shared', srcSize: 1425176, dstSize: 1192492, patch: 'ccBGSSSE001-Fish.vcdiff', patchSha256: '6d5955ba200bc6d1afcdf9eb0baa3134aa2ea65691d1f6bddf12196aea99d333', dstSha256: '8bcf6f1f14404584f650fe95a461594b546e2898213d04ea969d6b24ce757288' },
  ] },
  { name: 'ccBGSSSE025-AdvDSGS.esm', variants: [
    { edition: 'Shared', srcSize: 812873, dstSize: 613611, patch: 'ccBGSSSE025-AdvDSGS.vcdiff', patchSha256: '8de092c469c65b6775b1708a16aa4f8a81ec8caa4e12aa472e8ebb8942cc0748', dstSha256: 'ca313e6ae5846c72fbe81a7aa1e0c1103378aa70bcfeb865ef1267508ab7da1d' },
  ] },
  { name: 'ccQDRSSE001-SurvivalMode.esl', variants: [
    { edition: 'Shared', srcSize: 240724, dstSize: 237701, patch: 'ccQDRSSE001-SurvivalMode.vcdiff', patchSha256: 'bba4cec10a375a3931ad9a2b38caa815d40fbdda521460442a504bbe715152f2', dstSha256: 'cb7f09c86c7ac61f33afa4a0b2a1690daaf0780f5e608074c8517256f62edbf2' },
  ] },
]

const byName = name => MASTERS.find(m => m.name.toLowerCase() === String(name).toLowerCase()) || null

function cleanedSizes(name) {
  const m = byName(name)
  return m ? m.variants.map(v => v.dstSize) : []
}

// 'cleaned', the variant whose patch cleans a file of this size, or null for a build no patch knows
function classify(name, size) {
  const m = byName(name)
  if (!m) return null
  if (m.variants.some(v => v.dstSize === size)) return 'cleaned'
  return m.variants.find(v => v.srcSize === size) || null
}

module.exports = { BACKUP_DIR, MASTERS, cleanedSizes, classify }

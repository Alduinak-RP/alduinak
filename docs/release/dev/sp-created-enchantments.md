## Player-made enchantments

Enchantments made at the enchanting table are runtime forms (`0xFF...`) that exist only in the game session that made them. Skyrim Platform now exposes them by definition, so other sessions can rebuild them.

### Reading
`getExtraContainerChanges` reports an `effects` array on `Enchantment` extras whose enchantment is a created (runtime) form:

```ts
interface EnchantmentEffect {
  effectId: number;  // MGEF form id
  magnitude: number;
  area: number;
  duration: number;
  cost: number;
}
```

### Creating
```ts
function createEnchantment(isWeapon: boolean, effects: EnchantmentEffect[]): number;
```
Makes (or reuses) a weapon or armor enchantment with these effects through `BGSCreatedObjectManager`, the way the enchanting table does, and returns its form id (0 on failure). Call it from `update`. The enchantment is kept alive for the rest of the session.

### Equipping
`setInventory` entries may carry `enchantmentId` and `maxCharge`; the item is added and equipped with that enchantment.

# Serverside Scripting Reference

Server declares `mp` global variable that gives access to the whole API.
This page contains the list of `mp` object methods available to use in scripts.

## mp.makeProperty()

Creates a new property that would be attached to all instances of `MpActor` and `MpObjectReference`. Values are saved to database automatically. See [Properties System](docs_properties_system.md) for more information. The server no longer sends `updateOwner` and `updateNeighbor` to clients; the two options are still accepted and ignored.

```typescript
/* Definition */
interface MakePropertyOptions {
  // If set to false, `updateOwner` would never be invoked
  // Player's client wouldn't see it's own value of this property
  // Reasonable for passwords and other secret values
  isVisibleByOwner: boolean;

  // If set to false, `updateNeighbor` would never be invoked
  // Player's client wouldn't see values of neighbor Actors/ObjectReferences
  isVisibleByNeighbors: boolean;

  // Body of functions that would be invoked on client every update.
  updateOwner: string; // For the PlayerCharacter
  updateNeighbor: string; // For each synchronized Actor/ObjectReference
}

interface Mp {
  // ...
  makeProperty(propertyName: string, options: MakePropertyOptions): void;
  // ...
}

/* Usage */
mp.makeProperty("playerLevel", {
    isVisibleByOwner: true,
    isVisibleByNeighbors: false,
    updateOwner: "ctx.sp.Game.setPlayerLevel(ctx.value)"
    updateNeighbor: ""
});
```

## mp.get()

Returns the actual value of a specified property. If there is no value, then `undefined` returned.

```typescript
/* Definition */
interface Mp {
  // ...
  get(formId: number, propertyName: string): void;
  // ...
}

/* Usage */
mp.get(0xff000000, "type");
mp.get(0xff000000, "pos");
mp.get(0xff000000, "myAwesomeProperty");
```

## mp.set()

Changes value of the specified property.

```typescript
/* Definition */
interface Mp {
  // ...
  set(formId: number, propertyName: string, newValue: any): void;
  // ...
}

/* Usage */
mp.set(0xff000000, "pos", [0, 0, 0]);
```

## mp.clear()

Clears added properties.

```typescript
// Definition
clear(): void;
```

```typescript
// Usage
mp.clear();
```

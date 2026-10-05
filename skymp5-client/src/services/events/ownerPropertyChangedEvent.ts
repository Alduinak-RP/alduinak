// Emitted by RemoteServer when an UpdateProperty or UpdateAppearance changes the player's own model
export interface OwnerPropertyChangedEvent {
    propName: string;
    value: unknown;
}

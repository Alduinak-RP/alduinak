// Emitted by WorldView when the player's sampled world or cell changes to another nonzero one; previous is 0 on the first sample
export interface PlayerWorldOrCellChangedEvent {
    worldOrCell: number;
    previous: number;
    interior: boolean;
}

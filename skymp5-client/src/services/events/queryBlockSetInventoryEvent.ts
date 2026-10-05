export interface QueryBlockSetInventoryEvent {
    // until: the Date.now() time the block ends
    block: (until: number) => void
}

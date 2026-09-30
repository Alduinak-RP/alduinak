// /board opens the nearest missive board menu, the chat road beside activating the board. BountyBoardSystem does all the work.

api.registerChatCommand('board', (actorId) => {
  const open = globalThis.__alduinakBountyOpen
  if (typeof open === 'function') open(actorId)
  else api.notifyActor(actorId, 'The notice boards are not in service right now.')
})

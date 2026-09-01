// /board opens the nearest missive board menu. The Missives board activator
// has no engine-side activate prompt under skymp, so chat is the way in for
// clients that predate the N hotkey. BountyBoardSystem does all the work.

api.registerChatCommand('board', (actorId) => {
  const open = globalThis.__alduinakBountyOpen
  if (typeof open === 'function') open(actorId)
  else api.notifyActor(actorId, 'The notice boards are not in service right now.')
})

// /f and /faction: FactionSystem picks the faction and the listeners (the sender included, raw commands have no local echo)

const speak = (actorId, args) => {
  const chat = globalThis.__alduinakFactionChat
  if (typeof chat !== 'function') return api.notifyActor(actorId, 'Faction chat is not available right now.')
  const result = chat(actorId, args) || {}
  if (result.error) return api.notifyActor(actorId, result.error)
  for (const id of result.recipients || []) api.deliver(id, result.line)
}

api.registerChatCommand('f', speak)
api.registerChatCommand('faction', speak)

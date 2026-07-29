// Example plugin: /ping in chat and `ping` in the manager console

api.registerChatCommand('ping', (actorId) => {
  api.notifyActor(actorId, 'Pong!')
})

api.registerConsoleCommand('ping', () => 'pong (' + api.players().length + ' online)')

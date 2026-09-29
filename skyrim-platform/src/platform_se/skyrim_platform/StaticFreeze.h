#pragma once

// Keyframes the havok bodies of placed objects as their 3D loads; actors, ammo and projectiles keep physics
namespace StaticFreeze {
void HandleSkseMessage(SKSE::MessagingInterface::Message* msg);

// A client copy of a server item is frozen like a placed ref; other runtime items are engine drops that stay dynamic
void MarkServerCopy(RE::FormID id, bool serverCopy);

// Game thread, once per Papyrus update
void Update();
}

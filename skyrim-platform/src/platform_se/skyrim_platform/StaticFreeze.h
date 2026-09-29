#pragma once

// Keyframes the havok bodies of placed objects as their 3D loads; actors, ammo and projectiles keep physics
namespace StaticFreeze {
void HandleSkseMessage(SKSE::MessagingInterface::Message* msg);

// Game thread, once per Papyrus update
void Update();
}

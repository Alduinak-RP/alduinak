#pragma once
#include "../server_guest_lib/Inventory.h"
#include "MessageBase.h"
#include "MsgType.h"
#include <optional>
#include <type_traits>

struct CraftItemMessage : public MessageBase<CraftItemMessage>
{
  static constexpr auto kMsgType =
    std::integral_constant<char, static_cast<char>(MsgType::CraftItem)>{};

  struct Data
  {
    template <class Archive>
    void Serialize(Archive& archive)
    {
      archive.Serialize("t", kMsgType)
        .Serialize("workbench", workbench)
        .Serialize("craftInputObjects", craftInputObjects)
        .Serialize("resultObjectId", resultObjectId)
        .Serialize("temperHealth", temperHealth);
    }

    uint32_t workbench = 0;
    Inventory craftInputObjects;
    uint32_t resultObjectId = 0;
    // Set when the result is an improved item: its new tempering level (1.1 Fine to 1.6 Legendary)
    std::optional<float> temperHealth;
  };

  template <class Archive>
  void Serialize(Archive& archive)
  {
    archive.Serialize("t", kMsgType).Serialize("data", data);
  }

  Data data;
};

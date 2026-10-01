#include "CreateActorMessage.h"
#include "Inventory.h"
#include "SetInventoryMessage.h"
#include <catch2/catch_all.hpp>
#include <nlohmann/json.hpp>
#include <simdjson.h>
#include <slikenet/BitStream.h>
#include <vector>

namespace {

constexpr uint32_t kSteelSword = 0x13989;
constexpr uint32_t kIronSword = 0x12eb7;

Inventory::Entry Sword(uint32_t count, std::optional<float> condition,
                       std::optional<std::string> name = std::nullopt)
{
  Inventory::Entry entry(kSteelSword, count);
  entry.condition = condition;
  entry.name = std::move(name);
  return entry;
}

std::vector<uint8_t> Bytes(const IMessageBase& message)
{
  SLNet::BitStream stream;
  message.WriteBinary(stream);
  return { stream.GetData(),
           stream.GetData() + stream.GetNumberOfBytesUsed() };
}

template <class Message>
Message Read(std::vector<uint8_t> bytes)
{
  SLNet::BitStream stream(bytes.data(), static_cast<unsigned>(bytes.size()),
                          false);
  Message message;
  message.ReadBinary(stream);
  return message;
}

// The message a client built before the field reads: the same fields without the tail
struct OldSetInventoryMessage : public MessageBase<OldSetInventoryMessage>
{
  template <class Archive>
  void Serialize(Archive& archive)
  {
    archive.Serialize("t", SetInventoryMessage::kMsgType)
      .Serialize("inventory", inventory);
  }

  Inventory inventory;
};

}

TEST_CASE("An inventory without condition keeps its JSON",
          "[Inventory][Durability]")
{
  const char* stored =
    R"({"entries":[{"baseId":80265,"count":2},{"baseId":77495,"count":1,"health":1.2000000476837158,"worn":true,"wornLeft":false}]})";
  const auto inv = Inventory::FromJson(nlohmann::json::parse(stored));
  REQUIRE(inv.ToJson().dump() == stored);
  for (const auto& entry : inv.entries) {
    REQUIRE_FALSE(entry.condition.has_value());
  }

  simdjson::dom::parser parser;
  const simdjson::dom::element element = parser.parse(std::string(stored));
  const auto viaSimdjson = Inventory::FromJson(element);
  REQUIRE(viaSimdjson == inv);
  REQUIRE(viaSimdjson.ToJson().dump() == stored);
}

TEST_CASE("Condition survives the JSON round trip", "[Inventory][Durability]")
{
  Inventory inv;
  inv.AddItems({ Sword(1, 0.9714f), Sword(2, std::nullopt), Sword(1, 0.f) });
  REQUIRE(inv.entries.size() == 3);

  const auto json = inv.ToJson();
  REQUIRE(json["entries"][0]["condition"].get<float>() == 0.9714f);
  REQUIRE_FALSE(json["entries"][1].contains("condition"));
  REQUIRE(json["entries"][2]["condition"].get<float>() == 0.f);

  REQUIRE(Inventory::FromJson(json) == inv);
  simdjson::dom::parser parser;
  const simdjson::dom::element element = parser.parse(json.dump());
  REQUIRE(Inventory::FromJson(element) == inv);
}

TEST_CASE("Copies at different condition stay apart, the same item to "
          "clients",
          "[Inventory][Durability]")
{
  const auto pristine = Sword(1, std::nullopt);
  const auto worn = Sword(1, 0.4f);
  REQUIRE_FALSE(pristine.EqualExceptCount(worn));
  REQUIRE(pristine.SameItemAs(worn));
  REQUIRE_FALSE(worn.HasIdentityExtras());

  Inventory inv;
  inv.AddItems({ pristine, worn, Sword(1, 0.4f) });
  REQUIRE(inv.entries.size() == 2);
  REQUIRE(inv.entries[1].count == 2);

  // A plain removal takes pristine copies only
  inv.RemoveItems({ Sword(1, std::nullopt) });
  REQUIRE(inv.entries.size() == 1);
  REQUIRE_THROWS(inv.RemoveItems({ Sword(1, std::nullopt) }));
  inv.RemoveItems({ Sword(2, 0.4f) });
  REQUIRE(inv.IsEmpty());
}

TEST_CASE("FindEntriesFor takes the copy the described name's tag points at",
          "[Inventory][Durability]")
{
  Inventory inv;
  inv.AddItems({ Sword(1, 0.97f), Sword(1, 0.4f), Sword(1, std::nullopt),
                 Sword(1, 0.f) });

  const auto find = [&](const char* name, uint32_t count = 1) {
    return inv.FindEntriesFor(Sword(count, std::nullopt, std::string(name)));
  };

  auto found = find("Steel Sword (40%)");
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.4f));
  REQUIRE(found[0].count == 1);

  found = find("Steel Sword (97%) (Fine)");
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.97f));

  found = find("Steel Sword (100%)");
  REQUIRE(found.size() == 1);
  REQUIRE_FALSE(found[0].condition.has_value());

  found = find("Steel Sword (Broken)");
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.f));

  // A tag the wear has moved on from still finds the closest copy
  found = find("Steel Sword (43%)");
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.4f));

  // Two of them: the closest first, then the next
  found = find("Steel Sword (95%)", 2);
  REQUIRE(found.size() == 2);
  REQUIRE(found[0].condition == std::optional<float>(0.97f));
  REQUIRE_FALSE(found[1].condition.has_value());

  // Without a tag the order of the entries decides, as before the field
  found = find("Steel Sword");
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.97f));

  // More than there are: nothing
  REQUIRE(find("Steel Sword (40%)", 5).empty());

  // Another base is never taken
  REQUIRE(inv.FindEntriesFor(Inventory::Entry(kIronSword, 1)).empty());

  // A described entry without a name takes the pristine copy by exact extras
  found = inv.FindEntriesFor(Sword(1, std::nullopt));
  REQUIRE(found.size() == 1);
  REQUIRE_FALSE(found[0].condition.has_value());
}

TEST_CASE("The tag draw changes nothing while no copy carries a condition",
          "[Inventory][Durability]")
{
  Inventory inv;
  Inventory::Entry tempered = Sword(1, std::nullopt);
  tempered.health = 1.2f;
  inv.AddItems({ Sword(3, std::nullopt), tempered });

  auto described = Sword(2, std::nullopt, std::string("Steel Sword (40%)"));
  auto found = inv.FindEntriesFor(described);
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].count == 2);
  REQUIRE_FALSE(found[0].health.has_value());
}

TEST_CASE("The broken label of the settings is the one read back",
          "[Inventory][Durability]")
{
  struct Reset
  {
    ~Reset() { Inventory::SetBrokenLabel("Broken"); }
  } reset;

  Inventory inv;
  inv.AddItems({ Sword(1, 0.8f), Sword(1, 0.f) });
  Inventory::SetBrokenLabel("Kaputt");
  REQUIRE(Inventory::GetBrokenLabel() == "Kaputt");
  auto found =
    inv.FindEntriesFor(Sword(1, std::nullopt, std::string("Sword (Kaputt)")));
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.f));
  // The old label is no tag any more, so the first copy is taken
  found =
    inv.FindEntriesFor(Sword(1, std::nullopt, std::string("Sword (Broken)")));
  REQUIRE(found.size() == 1);
  REQUIRE(found[0].condition == std::optional<float>(0.8f));
}

TEST_CASE("SetInventory without condition is byte for byte the old message",
          "[Inventory][Durability][Serialization]")
{
  SetInventoryMessage message;
  Inventory::Entry tempered = Sword(1, std::nullopt, std::string("Sting"));
  tempered.health = 1.3f;
  tempered.SetWorn(Inventory::Worn::Right);
  message.inventory.AddItems({ Inventory::Entry(0xf, 250), tempered });

  OldSetInventoryMessage old;
  old.inventory = message.inventory;
  REQUIRE(Bytes(message) == Bytes(old));

  const auto read = Read<SetInventoryMessage>(Bytes(message));
  REQUIRE(read.inventory == message.inventory);
}

TEST_CASE("Conditions ride behind the fields an old client reads",
          "[Inventory][Durability][Serialization]")
{
  SetInventoryMessage message;
  message.inventory.AddItems({ Inventory::Entry(0xf, 250), Sword(1, 0.9714f),
                               Sword(2, std::nullopt), Sword(1, 0.f) });
  const auto bytes = Bytes(message);

  // The layout up to the tail is the old one
  OldSetInventoryMessage plain;
  plain.inventory = message.inventory;
  for (auto& entry : plain.inventory.entries) {
    entry.condition.reset();
  }
  const auto plainBytes = Bytes(plain);
  REQUIRE(bytes.size() > plainBytes.size());

  // A client built before the field reads the inventory and stops
  const auto old = Read<OldSetInventoryMessage>(bytes);
  REQUIRE(old.inventory == plain.inventory);

  // A client that knows the tail gets every condition
  const auto read = Read<SetInventoryMessage>(bytes);
  REQUIRE(read.inventory == message.inventory);
  REQUIRE(read.inventory.entries[1].condition ==
          std::optional<float>(0.9714f));
  REQUIRE_FALSE(read.inventory.entries[2].condition.has_value());
  REQUIRE(read.inventory.entries[3].condition == std::optional<float>(0.f));

  // The same client reads a message of a server without the tail
  const auto fromOldServer = Read<SetInventoryMessage>(plainBytes);
  REQUIRE(fromOldServer.inventory == plain.inventory);

  // Its JSON for the client scripts carries the field
  nlohmann::json json;
  read.WriteJson(json);
  REQUIRE(json["inventory"]["entries"][1]["condition"].get<float>() ==
          0.9714f);
  REQUIRE_FALSE(json["inventory"]["entries"][2].contains("condition"));
}

TEST_CASE("CreateActor carries the conditions of its inventory in a tail",
          "[Inventory][Durability][Serialization]")
{
  CreateActorMessage message;
  message.idx = 7;
  message.isMe = true;
  message.props.inventory = Inventory();
  message.props.inventory->AddItems(
    { Sword(1, 0.5f), Inventory::Entry(0xf, 10) });
  message.equipment = Equipment();
  Inventory::Entry worn = Sword(1, 0.5f);
  worn.SetWorn(Inventory::Worn::Right);
  message.equipment->inv.AddItems({ worn });

  const auto read = Read<CreateActorMessage>(Bytes(message));
  REQUIRE(read.idx == 7);
  REQUIRE(read.props.inventory.has_value());
  REQUIRE(read.props.inventory->entries[0].condition ==
          std::optional<float>(0.5f));
  REQUIRE_FALSE(read.props.inventory->entries[1].condition.has_value());
  // Worn entries of the equipment never send it
  REQUIRE(read.equipment.has_value());
  REQUIRE_FALSE(read.equipment->inv.entries[0].condition.has_value());

  // Without a condition nothing follows the old fields
  CreateActorMessage plain = message;
  plain.props.inventory->entries[0].condition.reset();
  const auto plainBytes = Bytes(plain);
  REQUIRE(Bytes(message).size() == plainBytes.size() + 12);
  const auto readPlain = Read<CreateActorMessage>(plainBytes);
  REQUIRE_FALSE(readPlain.props.inventory->entries[0].condition.has_value());
}

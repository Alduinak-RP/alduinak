#pragma once

#include "MessageBase.h"
#include "MsgType.h"
#include <cstdint>
#include <memory>
#include <nlohmann/json_fwd.hpp>
#include <optional>
#include <slikenet/types.h>
#include <vector>

namespace simdjson::dom {
class element;
}

class MessageSerializer;

class MessageSerializerFactory
{
public:
  static std::shared_ptr<MessageSerializer> CreateMessageSerializer();
};

struct DeserializeResult
{
  MsgType msgType = MsgType::Invalid;
  std::unique_ptr<IMessageBase> message;
};

class MessageSerializer
{
  friend class MessageSerializerFactory;

public:
  void Serialize(const char* jsonContent, SLNet::BitStream& outputStream);

  void Serialize(const IMessageBase& message, SLNet::BitStream& outputStream);

  std::optional<DeserializeResult> Deserialize(const uint8_t* rawMessage,
                                               size_t length);

private:
  typedef void (*SerializeFn)(const simdjson::dom::element& inputJson,
                              SLNet::BitStream& outputStream);
  typedef DeserializeResult (*DeserializeFn)(const uint8_t* rawMessage,
                                             size_t length);

  MessageSerializer(std::vector<SerializeFn> serializerFns,
                    std::vector<DeserializeFn> deserializerFns);

  const std::vector<SerializeFn> serializerFns;
  const std::vector<DeserializeFn> deserializerFns;
};

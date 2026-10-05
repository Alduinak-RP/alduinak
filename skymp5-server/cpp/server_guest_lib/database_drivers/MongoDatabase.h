#pragma once
#include "MpChangeForms.h"
#include "utils/JsonSanitizer.h"
#include <database_drivers/IDatabase.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <simdjson.h>

class MongoDatabase
  : public Viet::IDatabase<MpChangeForm, FormDesc, std::vector<FormDesc>>
{
public:
  MongoDatabase(const std::string& uri_, const std::string& name_);

  // IDatabase
  void Iterate(const IterateCallback& iterateCallback,
               std::optional<std::vector<FormDesc>> filter) override;

private:
  std::vector<std::optional<MpChangeForm>>&& UpsertImpl(
    std::vector<std::optional<MpChangeForm>>&& changeForms,
    size_t& outNumUpserted) override;

  MpChangeForm ParseDocument(simdjson::dom::parser& parser,
                             const std::string& json);

  std::string BytesToHexString(const uint8_t* bytes, size_t length);
  std::string Sha256(const std::string& str);

  struct Impl;
  std::shared_ptr<Impl> pImpl;
};

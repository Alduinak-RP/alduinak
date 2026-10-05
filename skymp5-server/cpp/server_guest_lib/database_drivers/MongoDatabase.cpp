#include "MongoDatabase.h"

#include "JsonUtils.h"
#include <save_storages/AsyncSaveStorage.h>

#ifndef NO_MONGO
#  include <bsoncxx/builder/stream/document.hpp>
#  include <bsoncxx/document/element.hpp>
#  include <bsoncxx/document/value.hpp>
#  include <bsoncxx/document/view.hpp>
#  include <bsoncxx/document/view_or_value.hpp>
#  include <bsoncxx/json.hpp>
#  include <mongocxx/client.hpp>
#  include <mongocxx/exception/exception.hpp>
#  include <mongocxx/instance.hpp>
#  include <mongocxx/pool.hpp>
#  include <mongocxx/uri.hpp>
#endif

#include <chrono>
#include <sodium.h>
#include <spdlog/spdlog.h>
#include <thread>
#include <unordered_set>
#include <vector>

struct MongoDatabase::Impl
{
#ifndef NO_MONGO
  const std::string uri;
  const std::string name;

  const char* const collectionName = "changeForms";

  std::shared_ptr<mongocxx::pool> pool;

  std::unique_ptr<JsonSanitizer> jsonSanitizer;
#endif
};

#ifdef NO_MONGO
MongoDatabase::MongoDatabase(std::string uri_, std::string name_)
{
  throw std::runtime_error("MongoDB is not supported in this build");
}
std::vector<std::optional<MpChangeForm>>&& MongoDatabase::UpsertImpl(
  std::vector<std::optional<MpChangeForm>>&& changeForms,
  size_t& outNumUpserted)
{
  outNumUpserted = 0;
  return std::move(changeForms);
}

void MongoDatabase::Iterate(const IterateCallback&,
                            std::optional<std::vector<FormDesc>>)
{
}

#endif

#ifndef NO_MONGO
MongoDatabase::MongoDatabase(const std::string& uri_, const std::string& name_)
{
  static mongocxx::instance g_instance;

  // Since MongoDB 5.0, '$' and '.' are OK
  // Might be de-hardcoded in the future, for DocumentDB or something
  static const std::vector<char> kBannedCharactersMongo5 = { '\0' };

  pImpl.reset(new Impl{ uri_, name_ });
  pImpl->pool.reset(new mongocxx::pool(mongocxx::uri(pImpl->uri.data())));
  pImpl->jsonSanitizer.reset(
    new JsonSanitizer(kBannedCharactersMongo5,
                      [this](const std::string& str) { return Sha256(str); }));
}

std::vector<std::optional<MpChangeForm>>&& MongoDatabase::UpsertImpl(
  std::vector<std::optional<MpChangeForm>>&& changeForms,
  size_t& outNumUpserted)
{
  try {
    mongocxx::v_noabi::pool::entry poolEntry = pImpl->pool->acquire();

    mongocxx::v_noabi::collection collection =
      poolEntry->database(pImpl->name).collection(pImpl->collectionName);

    auto bulk = collection.create_bulk_write();
    for (auto& changeForm : changeForms) {
      if (changeForm == std::nullopt) {
        continue;
      }

      auto filter = nlohmann::json::object();
      filter["formDesc"] = changeForm->formDesc.ToString();

      // Deleted characters stay flagged
      if (changeForm->isDeleted && changeForm->profileId < 0) {
        bulk.append(
          mongocxx::model::delete_one(bsoncxx::from_json(filter.dump())));
        continue;
      }

      auto jChangeForm = MpChangeForm::ToJson(*changeForm);

      auto upd = nlohmann::json::object();
      upd["$set"] = pImpl->jsonSanitizer->SanitizeJsonRecursive(jChangeForm);

      // A reused ff id would otherwise keep optional keys of the previous owner
      auto unset = nlohmann::json::object();
      for (const char* key : { "templateChain", "factions", "displayName",
                               "setNodeScale", "setNodeTextureSet" }) {
        if (!jChangeForm.contains(key)) {
          unset[key] = "";
        }
      }
      if (!unset.empty()) {
        upd["$unset"] = std::move(unset);
      }

      bulk.append(mongocxx::model::update_one(
                    { std::move(bsoncxx::from_json(filter.dump())),
                      std::move(bsoncxx::from_json(upd.dump())) })
                    .upsert(true));
    }

    (void)bulk.execute();

    // TODO: Should take data from bulk.execute result instead?
    outNumUpserted = changeForms.size();

    return std::move(changeForms);
  } catch (std::exception& e) {
    throw Viet::AsyncSaveStorage<
      MpChangeForm, FormDesc,
      std::vector<FormDesc>>::UpsertFailedException(std::move(changeForms),
                                                    e.what());
  }
}

void MongoDatabase::Iterate(const IterateCallback& iterateCallback,
                            std::optional<std::vector<FormDesc>> filter)
{
  constexpr int kBatchSize = 1000;
  constexpr int kMaxAttempts = 5;

  try {
    nlohmann::json filterJson = { { "isDeleted", { { "$ne", true } } } };
    if (filter) {
      auto filterArr = nlohmann::json::array();
      for (const auto& desc : *filter) {
        filterArr.push_back(desc.ToString());
      }
      filterJson["formDesc"] = { { "$in", std::move(filterArr) } };
    }
    const auto filterBson = bsoncxx::from_json(filterJson.dump());

    mongocxx::options::find options;
    options.batch_size(kBatchSize);
    options.sort(bsoncxx::from_json(R"({"_id":1})"));

    simdjson::dom::parser parser;

    // A restarted cursor skips the formDescs already passed to the callback
    std::unordered_set<std::string> passed;

    for (int attempt = 1;; ++attempt) {
      try {
        mongocxx::v_noabi::pool::entry poolEntry = pImpl->pool->acquire();
        mongocxx::v_noabi::collection collection =
          poolEntry->database(pImpl->name).collection(pImpl->collectionName);

        for (const auto& documentView :
             collection.find(filterBson.view(), options)) {
          MpChangeForm changeForm =
            ParseDocument(parser, bsoncxx::to_json(documentView));
          std::string desc = changeForm.formDesc.ToString();
          if (attempt > 1 && passed.count(desc)) {
            continue;
          }
          iterateCallback(changeForm);
          passed.insert(std::move(desc));
        }
        return;
      } catch (const mongocxx::exception& e) {
        if (attempt >= kMaxAttempts) {
          throw;
        }
        spdlog::warn("MongoDatabase::Iterate - cursor failed after {} "
                     "documents (attempt {}): {}, restarting",
                     passed.size(), attempt, e.what());
        std::this_thread::sleep_for(std::chrono::seconds(attempt));
      }
    }
  } catch (std::exception& e) {
    throw Viet::AsyncSaveStorage<
      MpChangeForm, FormDesc,
      std::vector<FormDesc>>::IterateFailedException(std::move(filter),
                                                     e.what());
  }
}

MpChangeForm MongoDatabase::ParseDocument(simdjson::dom::parser& parser,
                                          const std::string& json)
{
  simdjson::dom::element document = parser.parse(json).value();
  if (json.find(pImpl->jsonSanitizer->GetEncKeysKey()) == std::string::npos) {
    return MpChangeForm::JsonToChangeForm(document);
  }

  bool restored = false;
  nlohmann::json restoredDocument =
    pImpl->jsonSanitizer->RestoreSanitizedJsonRecursive(document, restored);
  if (!restored) {
    return MpChangeForm::JsonToChangeForm(document);
  }

  simdjson::dom::element restoredElement =
    parser.parse(restoredDocument.dump()).value();
  return MpChangeForm::JsonToChangeForm(restoredElement);
}

std::string MongoDatabase::BytesToHexString(const uint8_t* bytes,
                                            size_t length)
{
  static constexpr auto kHexDigits = "0123456789abcdef";

  std::string hexStr(length * 2, ' ');
  for (size_t i = 0; i < length; ++i) {
    hexStr[2 * i] = kHexDigits[(bytes[i] >> 4) & 0xF];
    hexStr[2 * i + 1] = kHexDigits[bytes[i] & 0xF];
  }

  return hexStr;
}

std::string MongoDatabase::Sha256(const std::string& str)
{
  unsigned char hash[crypto_hash_sha256_BYTES];
  crypto_hash_sha256(hash, reinterpret_cast<const unsigned char*>(str.data()),
                     str.size());
  return BytesToHexString(hash, crypto_hash_sha256_BYTES);
}

#endif // #ifndef NO_MONGO

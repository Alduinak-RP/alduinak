#include "ModuleListApi.h"
#include "InvalidArgumentException.h"

#include <bcrypt.h>
#include <psapi.h>

#include <unordered_map>

#pragma comment(lib, "bcrypt.lib")

namespace {

struct FileStamp
{
  uint64_t size = 0;
  uint64_t writeTime = 0;
};

struct CachedHash
{
  FileStamp stamp;
  std::string sha256;
};

std::vector<std::wstring> LoadedModulePaths()
{
  const HANDLE process = GetCurrentProcess();
  std::vector<HMODULE> modules(1024);
  DWORD needed = 0;
  for (int attempt = 0; attempt < 2; ++attempt) {
    const auto bytes = static_cast<DWORD>(modules.size() * sizeof(HMODULE));
    if (!EnumProcessModules(process, modules.data(), bytes, &needed)) {
      return {};
    }
    if (needed <= bytes) {
      break;
    }
    modules.resize(needed / sizeof(HMODULE) + 64);
  }
  modules.resize(
    std::min<size_t>(modules.size(), needed / sizeof(HMODULE)));

  std::vector<std::wstring> paths;
  std::wstring buffer(32768, L'\0');
  for (const auto module : modules) {
    const DWORD length = GetModuleFileNameW(module, buffer.data(),
                                            static_cast<DWORD>(buffer.size()));
    if (length > 0 && length < buffer.size()) {
      paths.emplace_back(buffer.data(), length);
    }
  }
  return paths;
}

std::optional<FileStamp> Stamp(const std::wstring& path)
{
  WIN32_FILE_ATTRIBUTE_DATA data;
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) {
    return std::nullopt;
  }
  FileStamp stamp;
  stamp.size = (static_cast<uint64_t>(data.nFileSizeHigh) << 32) |
    data.nFileSizeLow;
  stamp.writeTime =
    (static_cast<uint64_t>(data.ftLastWriteTime.dwHighDateTime) << 32) |
    data.ftLastWriteTime.dwLowDateTime;
  return stamp;
}

std::string Sha256File(const std::wstring& path)
{
  const HANDLE file = CreateFileW(
    path.c_str(), GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
    OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    return "";
  }

  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::string result;
  if (BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
        &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) &&
      BCRYPT_SUCCESS(
        BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0))) {
    std::vector<UCHAR> buffer(1 << 20);
    bool ok = true;
    for (;;) {
      DWORD read = 0;
      if (!ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()),
                    &read, nullptr)) {
        ok = false;
        break;
      }
      if (read == 0) {
        break;
      }
      if (!BCRYPT_SUCCESS(BCryptHashData(hash, buffer.data(), read, 0))) {
        ok = false;
        break;
      }
    }
    UCHAR digest[32];
    if (ok &&
        BCRYPT_SUCCESS(BCryptFinishHash(hash, digest, sizeof(digest), 0))) {
      static const char* kHex = "0123456789abcdef";
      for (const auto byte : digest) {
        result += kHex[byte >> 4];
        result += kHex[byte & 0xf];
      }
    }
  }
  if (hash) {
    BCryptDestroyHash(hash);
  }
  if (algorithm) {
    BCryptCloseAlgorithmProvider(algorithm, 0);
  }
  CloseHandle(file);
  return result;
}

std::wstring Lower(std::wstring s)
{
  CharLowerBuffW(s.data(), static_cast<DWORD>(s.size()));
  return s;
}

std::u16string ToU16(const std::wstring& s)
{
  return std::u16string(reinterpret_cast<const char16_t*>(s.data()),
                        s.size());
}

}

// Every module of the game process with its file size; size is -1 when the file cannot be read
Napi::Value ModuleListApi::GetLoadedModules(const Napi::CallbackInfo& info)
{
  auto env = info.Env();
  const auto paths = LoadedModulePaths();
  auto result = Napi::Array::New(env, paths.size());
  for (size_t i = 0; i < paths.size(); ++i) {
    const auto stamp = Stamp(paths[i]);
    auto entry = Napi::Object::New(env);
    entry.Set("path", Napi::String::New(env, ToU16(paths[i])));
    entry.Set("size",
              Napi::Number::New(
                env, stamp ? static_cast<double>(stamp->size) : -1.0));
    result.Set(static_cast<uint32_t>(i), entry);
  }
  return result;
}

// Hashes only a module loaded in this process, so scripts cannot read other files; cached by path, size and write time
Napi::Value ModuleListApi::GetModuleSha256(const Napi::CallbackInfo& info)
{
  static std::unordered_map<std::wstring, CachedHash> g_cache;

  const auto utf8 = NapiHelper::ExtractString(info[0], "path");
  const auto u16 = info[0].As<Napi::String>().Utf16Value();
  const std::wstring path(reinterpret_cast<const wchar_t*>(u16.data()),
                          u16.size());
  const auto key = Lower(path);

  const auto paths = LoadedModulePaths();
  const bool loaded = std::any_of(paths.begin(), paths.end(),
                                  [&](const std::wstring& p) {
                                    return Lower(p) == key;
                                  });
  if (!loaded) {
    throw InvalidArgumentException("path", utf8);
  }

  const auto stamp = Stamp(path);
  if (!stamp) {
    return Napi::String::New(info.Env(), "");
  }
  auto it = g_cache.find(key);
  if (it == g_cache.end() || it->second.stamp.size != stamp->size ||
      it->second.stamp.writeTime != stamp->writeTime) {
    it = g_cache.insert_or_assign(key, CachedHash{ *stamp, Sha256File(path) })
           .first;
  }
  return Napi::String::New(info.Env(), it->second.sha256);
}

void ModuleListApi::Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set("getLoadedModules", Napi::Function::New(env, GetLoadedModules));
  exports.Set("getModuleSha256", Napi::Function::New(env, GetModuleSha256));
}

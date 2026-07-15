#include "Validators.h"

bool ValidateFilename(std::string_view filename, bool allowDots)
{
  if (filename.empty()) {
    return false;
  }
  for (size_t i = 0; i < filename.size(); ++i) {
    const char c = filename[i];
    if (static_cast<unsigned char>(c) < 0x20) {
      return false;
    }
    if (c == '/' || c == '\\' || c == ':') {
      return false;
    }
    if (c == '.' && !allowDots) {
      return false;
    }
    if (c == '.' && i > 0 && filename[i - 1] == '.') {
      return false;
    }
  }
  return true;
}

bool ValidateRelativePath(std::string_view path)
{
  for (size_t i = 0; i < path.size(); ++i) {
    // Forbid everything including ':' and null character
    const char& c = path[i];
    if (!(('0' <= c && c <= '9') || ('A' <= c && c <= 'Z') ||
          ('a' <= c && c <= 'z') || c == '.' || c == '-' || c == '_' ||
          c == '/' || c == '\\')) {
      return false;
    }
    if (i > 0 && path[i - 1] == '.' && path[i] == '.') {
      return false;
    }
  }
  return true;
}

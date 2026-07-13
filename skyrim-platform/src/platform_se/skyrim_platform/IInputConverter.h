#pragma once

class IInputConverter
{
public:
  // Returns 0 on failure
  virtual wchar_t VkCodeToChar(uint8_t virtualKeyCode, bool shiftDown,
                               bool capsLockOn) noexcept = 0;
};

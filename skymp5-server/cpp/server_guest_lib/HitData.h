#pragma once

#include "HitMessage.h"
#include <cstdint>

using HitData = HitMessage::Data;

// HitData::source of a fist attack
constexpr uint32_t kUnarmedSource = 0x1f4;

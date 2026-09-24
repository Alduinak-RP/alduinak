#include "CalendarApi.h"
#include "NullPointerException.h"

// The engine rebuilds GameDaysPassed every frame as rawDaysPassed + GameHour / 24; returns the new GameDaysPassed
Napi::Value CalendarApi::SetRawDaysPassed(const Napi::CallbackInfo& info)
{
  float days = NapiHelper::ExtractFloat(info[0], "days");
  auto calendar = RE::Calendar::GetSingleton();
  if (!calendar)
    throw NullPointerException("calendar");
  if (!calendar->gameDaysPassed || !calendar->gameHour)
    throw NullPointerException("gameDaysPassed");
  calendar->rawDaysPassed = std::floor(days);
  calendar->gameDaysPassed->value =
    calendar->rawDaysPassed + calendar->gameHour->value / 24.f;
  return Napi::Number::New(info.Env(), calendar->gameDaysPassed->value);
}

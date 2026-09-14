#pragma once

#include <Stl.hpp>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

class IInputListener;

namespace CEFUtils {
struct DInputHook
{
  static bool& ChromeFocus()
  {
    static bool chromeFocus;
    return chromeFocus;
  }

  // Foreground window, browser focus, raw input targets and keyboard counters, for focus bug logs
  static std::string DescribeInputState();
  static std::string DescribeRawInput();
  static void ResetKeyboardCounters();
  // Called at postLoadGame; resets the counters, arms the first key logs and a keyboard re-acquire if no key gets through
  static void OnEnteredGame();
  // True for the first few key downs after entering the game
  static bool TakeEnteredGameKeyLog();

  struct
  {
    std::mutex m;
    std::vector<std::function<void()>> tasks;
  } share;

  void Task(std::function<void()> f)
  {
    std::lock_guard<std::mutex> l(share.m);
    share.tasks.push_back(f);
  }

  void RunTasks()
  {
    std::vector<std::function<void()>> tasks_;
    {
      std::lock_guard<std::mutex> l(share.m);
      tasks_ = share.tasks;
    }
    for (auto& t : tasks_)
      t();
  }

  TP_NOCOPYMOVE(DInputHook);

  void SetEnabled(bool aEnabled) noexcept
  {
    m_enabled = aEnabled;
    Update();
  }
  [[nodiscard]] bool IsEnabled() const noexcept { return m_enabled; }
  void SetToggleKeys(std::initializer_list<unsigned long> aKeys) noexcept;
  [[nodiscard]] bool IsToggleKey(unsigned int aKey) const noexcept;

  void Acquire() const noexcept;
  void Unacquire() const noexcept;

  static void Install(std::shared_ptr<IInputListener> listener) noexcept;
  static DInputHook& Get() noexcept;

  void Update() const noexcept;

private:
  DInputHook() noexcept;
  ~DInputHook() = default;

  Set<unsigned long> m_toggleKeys;

  bool m_enabled{ false };
};
}

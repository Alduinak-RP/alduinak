#include <MyBrowserProcessHandler.h>

namespace CEFUtils {
void MyBrowserProcessHandler::OnBeforeChildProcessLaunch(
  CefRefPtr<CefCommandLine> command_line)
{
  command_line->AppendSwitchWithValue("pid",
                                      std::to_string(GetCurrentProcessId()));
  // Voice chat: renderer/utility children must also carry the media switches
  command_line->AppendSwitch("enable-media-stream");
  command_line->AppendSwitch("use-fake-ui-for-media-stream");
}
}

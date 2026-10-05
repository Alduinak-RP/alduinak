#include "Networking.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <deque>
#include <memory>
#include <vector>

#include <antigo/ExecutionData.h>
#include <antigo/ResolvedContext.h>
#include <fmt/format.h>
#include <prometheus/core.h>
#include <prometheus/gauge.h>
#include <prometheus/histogram.h>
#include <slikenet/MessageIdentifiers.h>
#include <slikenet/types.h>
#include <spdlog/spdlog.h>

#include "IdManager.h"
#include "NetworkingInterface.h"

namespace {
class PacketGuard
{
public:
  PacketGuard(RakPeerInterface* peer_, Packet* packet_)
    : peer(peer_)
    , packet(packet_)
  {
  }

  ~PacketGuard() { peer->DeallocatePacket(packet); }

private:
  RakPeerInterface* const peer;
  Packet* const packet;
};

const char* GetError(unsigned char packetType)
{
  switch (packetType) {
    case ID_ALREADY_CONNECTED:
      return "Already connected";
    case ID_CONNECTION_BANNED:
      return "Banned";
    case ID_INVALID_PASSWORD:
      return "Invalid password";
    case ID_INCOMPATIBLE_PROTOCOL_VERSION:
      return "Incompatible protocol version";
    case ID_IP_RECENTLY_CONNECTED:
      return "IP recently connected";
    case ID_NO_FREE_INCOMING_CONNECTIONS:
      return "No free incoming connections";
    default:
      return "";
  }
}

class Client : public Networking::IClient
{
public:
  Client(const char* ip_, unsigned short port_, int timeoutMs_,
         const char* password_)
    : ip(ip_)
    , port(port_)
    , password(password_)
  {

    peer.reset(new RakPeer);
    socket.reset(new SocketDescriptor(0, nullptr));
    const auto res = peer->Startup(1, &*socket, 1);
    if (res != StartupResult::RAKNET_STARTED) {
      throw std::runtime_error("Peer startup failed with code " +
                               std::to_string(static_cast<int>(res)));
    }
    const auto conRes = peer->Connect(ip.data(), port, password.data(),
                                      static_cast<int>(password.size()));
    if (conRes != ConnectionAttemptResult::CONNECTION_ATTEMPT_STARTED) {
      throw std::runtime_error("Peer connect failed with code " +
                               std::to_string(static_cast<int>(conRes)));
    }
    peer->SetTimeoutTime(timeoutMs_, {});
  }

  ~Client() override
  {
    packetGuard.reset(); // Depends on peer, so must be reset first
    // Waits briefly so the server gets the disconnect notification and frees the slot at once
    peer->Shutdown(kShutdownBlockMs);
  }

  void Send(Networking::PacketData data, size_t length, bool reliable) override
  {
    peer->Send(reinterpret_cast<const char*>(data), length, MEDIUM_PRIORITY,
               reliable ? RELIABLE : UNRELIABLE, 0, serverGuid, false);
  }

  void Tick(OnPacket onPacket, void* state) override
  {
    std::weak_ptr<SLNet::RakPeerInterface> weakPeer = peer;
    while (1) {
      Packet* packet = nullptr;
      auto p = weakPeer.lock();
      if (p) {
        packet = p->Receive();
        packetGuard.reset(new PacketGuard(&*p, packet));
      }
      p.reset();
      if (!packet)
        break;

      if (packet->data[0] == ID_CONNECTION_REQUEST_ACCEPTED) {
        serverGuid = packet->guid;
        isConnected = true;
      }

      if (packet->data[0] == ID_CONNECTION_LOST ||
          packet->data[0] == ID_DISCONNECTION_NOTIFICATION) {
        isConnected = false;
      }

      HandlePacketClientside(onPacket, state, packet);
    }
  }

  bool IsConnected() const override { return isConnected; }

private:
  const std::string ip;
  const unsigned short port;
  const std::string password;

  constexpr static unsigned int kShutdownBlockMs = 200;

  RakNetGUID serverGuid = UNASSIGNED_RAKNET_GUID;
  std::shared_ptr<RakPeerInterface> peer;
  std::unique_ptr<SocketDescriptor> socket;
  std::unique_ptr<PacketGuard> packetGuard;
  bool isConnected = false;
};

class Server : public Networking::IServer
{
public:
  constexpr static int timeoutTimeMs = 10000;

  Server(const char* listenAddress, unsigned short port_,
         unsigned short maxConnections_, const char* password_,
         std::shared_ptr<prometheus::Registry> promRegistry)
    : maxConnections(maxConnections_)
    , password(password_)
    , metrics{ Metrics::Init(promRegistry) }
  {
    if (maxConnections > kMaxPlayers) {
      throw std::runtime_error("Current slots limit is " +
                               std::to_string(kMaxPlayers));
    }

    idManager = std::make_unique<IdManager>(maxConnections);
    backlog.resize(maxConnections);
    userPacketsThisTick.resize(maxConnections);
    errorLogs.resize(maxConnections);
    pingGauges.resize(maxConnections);
    peer = std::make_unique<RakPeer>();
    socket = std::make_unique<SocketDescriptor>(port_, listenAddress);

    const auto res = peer->Startup(maxConnections, &*socket, 1);
    if (res != StartupResult::RAKNET_STARTED) {
      throw std::runtime_error("Peer startup failed with code " +
                               std::to_string(static_cast<int>(res)));
    }
    peer->SetMaximumIncomingConnections(maxConnections);
    peer->SetTimeoutTime(timeoutTimeMs, {});
    if (!password.empty()) {
      peer->SetIncomingPassword(password.data(),
                                static_cast<int>(password.size()));
    }
    peer->SetLimitIPConnectionFrequency(true);
  }

  void Send(Networking::UserId id, Networking::PacketData data, size_t length,
            bool reliable) override
  {
    const auto guid = idManager->find(id);
    if (guid == RakNetGUID(-1)) {
      throw std::runtime_error("User with id " + std::to_string(id) +
                               " doesn't exist");
    }

    peer->Send(reinterpret_cast<const char*>(data), length, MEDIUM_PRIORITY,
               reliable ? RELIABLE_ORDERED : UNRELIABLE, 0, guid, false);
  }

  ~Server() override
  {
    for (auto& queue : backlog) {
      for (Packet* packet : queue) {
        peer->DeallocatePacket(packet);
      }
    }
  }

  void Tick(OnPacket onPacket, void* state) override
  {
    std::fill(userPacketsThisTick.begin(), userPacketsThisTick.end(), 0);
    size_t packetsThisTick = 0;

    // Leftovers of earlier ticks go first, each user's in arrival order
    std::vector<Networking::UserId> waitingUsers;
    waitingUsers.swap(backlogUsers);
    for (Networking::UserId userId : waitingUsers) {
      auto& queue = backlog[userId];
      while (!queue.empty() && packetsThisTick < kMaxPacketsPerTick &&
             userPacketsThisTick[userId] < kMaxUserPacketsPerTick) {
        Packet* packet = queue.front();
        queue.pop_front();
        ++userPacketsThisTick[userId];
        ++packetsThisTick;
        HandlePacket(onPacket, state, packet, userId);
      }
      if (!queue.empty()) {
        backlogUsers.push_back(userId);
      }
    }

    while (packetsThisTick < kMaxPacketsPerTick) {
      Packet* packet = peer->Receive();
      if (!packet) {
        break;
      }
      const auto userId = idManager->find(packet->guid);
      if (userId != Networking::InvalidUserId) {
        auto& queue = backlog[userId];
        if (!queue.empty() ||
            userPacketsThisTick[userId] >= kMaxUserPacketsPerTick) {
          if (queue.empty()) {
            backlogUsers.push_back(userId);
          }
          queue.push_back(packet);
          continue;
        }
        ++userPacketsThisTick[userId];
      }
      ++packetsThisTick;
      HandlePacket(onPacket, state, packet, userId);
    }

    const auto currentTime = std::chrono::steady_clock::now();
    if (currentTime - lastMetricsUpdate > Metrics::kUpdatePeriod) {
      lastMetricsUpdate = currentTime;
      UpdateMetrics();
    }
  }

  void HandlePacket(OnPacket onPacket, void* state, Packet* packet,
                    Networking::UserId userId)
  {
    PacketGuard guard(peer.get(), packet);
    const auto packetId = packet->data[0];
    try {
      Networking::HandlePacketServerside(onPacket, state, packet,
                                         *this->idManager);
    } catch (const std::exception& e) {
      LogPacketError(userId, e.what());
    }
    if (userId != Networking::InvalidUserId &&
        (packetId == ID_DISCONNECTION_NOTIFICATION ||
         packetId == ID_CONNECTION_LOST)) {
      RemovePingGauge(userId);
    }
  }

  void LogPacketError(Networking::UserId userId, const char* what)
  {
    auto& errors =
      userId < errorLogs.size() ? errorLogs[userId] : unknownUserErrorLog;
    const auto now = std::chrono::steady_clock::now();
    if (now - errors.windowStart >= kErrorLogPeriod) {
      if (errors.suppressed > 0) {
        spdlog::error("Networking: {} more packet errors of user {} were not "
                      "logged",
                      errors.suppressed, userId);
      }
      errors = { now, 0, 0 };
    }

    const bool print = errors.lines < kErrorLinesPerPeriod;
    if (print) {
      ++errors.lines;
      spdlog::error("{}", what);
    } else {
      ++errors.suppressed;
    }
    while (antigo::HasExceptionWitness()) {
      auto witness = antigo::PopExceptionWitness();
      if (print) {
        spdlog::error(witness.ToString());
      }
    }
  }

  void UpdateMetrics()
  {
    DataStructures::List<SystemAddress> addresses;
    DataStructures::List<RakNetGUID> guids;
    peer->GetSystemList(addresses, guids);

    unsigned short connectedCount = 0;
    for (unsigned int i = 0; i < guids.Size(); ++i) {
      const auto userId = idManager->find(guids[i]);
      if (userId == Networking::InvalidUserId) {
        continue;
      }
      connectedCount++;

      const int clientPing = peer->GetLastPing(guids[i]);
      if (clientPing == -1) {
        RemovePingGauge(userId);
        continue;
      }
      auto& gauge = pingGauges[userId];
      if (!gauge) {
        gauge = &metrics.pingPerSlotGaugeFamily.Add(
          { { "networking_user_id", std::to_string(userId) } });
      }
      metrics.overallPingSecondsHistogram.Observe(clientPing / 1000.);
      gauge->Set(clientPing / 1000.);
    }

    metrics.connectedClientsGauge.Set(connectedCount);
  }

  void RemovePingGauge(Networking::UserId userId)
  {
    if (auto& gauge = pingGauges[userId]) {
      metrics.pingPerSlotGaugeFamily.Remove(gauge);
      gauge = nullptr;
    }
  }

  std::string GetIp(Networking::UserId userId) const override
  {
    const auto guid = idManager->find(userId);
    if (guid == RakNetGUID(-1)) {
      throw std::runtime_error("User with id " + std::to_string(userId) +
                               " doesn't exist");
    }

    auto address = peer->GetSystemAddressFromGuid(guid);
    std::string ip = address.ToString(false);
    return ip;
  }

  void CloseConnection(Networking::UserId userId) override
  {
    const auto guid = idManager->find(userId);
    if (guid == RakNetGUID(-1)) {
      throw std::runtime_error("User with id " + std::to_string(userId) +
                               " doesn't exist");
    }

    peer->CloseConnection(guid, true);
  }

private:
  const unsigned short maxConnections;
  const std::string password;
  std::unique_ptr<RakPeerInterface> peer;
  std::unique_ptr<SocketDescriptor> socket;
  std::unique_ptr<IdManager> idManager;

  // Packets past a budget wait for the next tick, so a flood cannot stall it
  constexpr static size_t kMaxPacketsPerTick = 4096;
  constexpr static uint16_t kMaxUserPacketsPerTick = 64;
  constexpr static std::chrono::seconds kErrorLogPeriod{ 10 };
  constexpr static uint32_t kErrorLinesPerPeriod = 5;

  struct ErrorLog
  {
    std::chrono::steady_clock::time_point windowStart;
    uint32_t lines = 0;
    uint32_t suppressed = 0;
  };

  std::vector<std::deque<Packet*>> backlog;
  std::vector<Networking::UserId> backlogUsers;
  std::vector<uint16_t> userPacketsThisTick;
  std::vector<ErrorLog> errorLogs;
  ErrorLog unknownUserErrorLog;
  std::vector<prometheus::Gauge<double>*> pingGauges;

  std::chrono::time_point<std::chrono::steady_clock> lastMetricsUpdate;

  struct Metrics
  {
    std::shared_ptr<prometheus::Registry> registry;
    prometheus::Gauge<double&> connectedClientsGauge;
    prometheus::Histogram<double&> overallPingSecondsHistogram;
    prometheus::CustomFamily<prometheus::Gauge<double>>&
      pingPerSlotGaugeFamily;

    static constexpr std::chrono::seconds kUpdatePeriod{ 3 };

    static Metrics Init(std::shared_ptr<prometheus::Registry> registry)
    {
      return {
        .registry = registry,
        .connectedClientsGauge{
          registry,
          "skymp_server_connected_clients_count",
          "Count of currently conneted clients (as seen by ID manager)",
        },
        .overallPingSecondsHistogram{
          registry,
          "skymp_server_overall_ping_seconds",
          "Overview of all connected clients' ping. Converted to seconds to "
          "match Prometheus conventions",
          {},
          {
            0.025,
            0.050,
            0.075,
            0.100,
            0.125,
            0.150,
            0.175,
            0.200,
            0.250,
            0.300,
            0.400,
          },
        },
        .pingPerSlotGaugeFamily{ registry->Add<prometheus::Gauge<double>>(
          "skymp_server_ping_per_slot_seconds",
          "Last known ping for each server slot. Converted to seconds to "
          "match Prometheus conventions") },
      };
    }
  };
  Metrics metrics;
};
} // namespace

std::shared_ptr<Networking::IClient> Networking::CreateClient(
  const char* serverIp, unsigned short serverPort, int timeoutMs,
  const char* password)
{
  return std::make_shared<Client>(serverIp, serverPort, timeoutMs, password);
}

std::shared_ptr<Networking::IServer> Networking::CreateServer(
  const char* listenAddress, unsigned short port,
  unsigned short maxConnections, const char* password,
  std::shared_ptr<prometheus::Registry> promRegistry)
{
  return std::make_shared<Server>(listenAddress, port, maxConnections,
                                  password, promRegistry);
}

void Networking::HandlePacketClientside(Networking::IClient::OnPacket onPacket,
                                        void* state, Packet* packet)
{
  const auto packetId = packet->data[0];
  const auto err = GetError(packetId);
  if (packetId >= Networking::MinPacketId) {
    onPacket(state, Networking::PacketType::Message, packet->data,
             packet->length, "");
  } else if (packetId == ID_CONNECTION_LOST ||
             packetId == ID_DISCONNECTION_NOTIFICATION) {
    onPacket(state, Networking::PacketType::ClientSideDisconnect, nullptr, 0,
             "");
  } else if (packetId == ID_CONNECTION_ATTEMPT_FAILED) {
    onPacket(state, Networking::PacketType::ClientSideConnectionFailed,
             nullptr, 0, "");
  } else if (packetId == ID_CONNECTION_REQUEST_ACCEPTED) {
    onPacket(state, Networking::PacketType::ClientSideConnectionAccepted,
             nullptr, 0, "");
  } else if (err[0]) {
    onPacket(state, Networking::PacketType::ClientSideConnectionDenied,
             nullptr, 0, err);
  }
}

void Networking::HandlePacketServerside(Networking::IServer::OnPacket onPacket,
                                        void* state, Packet* packet,
                                        IdManager& idManager)
{
  const auto packetId = packet->data[0];
  Networking::UserId userId;
  switch (packetId) {
    case ID_DISCONNECTION_NOTIFICATION:
    case ID_CONNECTION_LOST:
      userId = idManager.find(packet->guid);
      if (userId == Networking::InvalidUserId) {
        throw std::runtime_error(fmt::format(
          "Unexpected disconnection for system without userId (guid={})",
          packet->guid.g));
      }
      if (packetId == ID_CONNECTION_LOST) {
        spdlog::info(
          "Networking: user {} timed out without a disconnect notice", userId);
      }
      onPacket(state, userId, Networking::PacketType::ServerSideUserDisconnect,
               nullptr, 0);
      idManager.freeId(userId);
      break;
    case ID_NEW_INCOMING_CONNECTION: {
      userId = idManager.allocateId(packet->guid);
      if (userId == Networking::InvalidUserId) {
        throw std::runtime_error("idManager is full");
      }

      std::array<char, 256> guidToStringDestination;
      packet->guid.ToString(guidToStringDestination.data(),
                            std::size(guidToStringDestination));
      std::string guid = guidToStringDestination.data();

      onPacket(state, userId, Networking::PacketType::ServerSideUserConnect,
               reinterpret_cast<PacketData>(guid.data()), guid.size());

      break;
    }
    default:
      userId = idManager.find(packet->guid);
      if (packetId >= Networking::MinPacketId) {
        onPacket(state, userId, Networking::PacketType::Message, packet->data,
                 packet->length);
      }
      break;
  }
}

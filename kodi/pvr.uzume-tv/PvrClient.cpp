#include <kodi/AddonBase.h>
#include <kodi/Filesystem.h>
#include <kodi/addon-instance/PVR.h>
#include "json.hpp"

#include <algorithm>
#include <cstdint>
#include <map>
#include <mutex>
#include <set>
#include <string>

using Json = nlohmann::json;
using namespace kodi::addon;

namespace
{
struct WaveGroup
{
  const char* type;
  const char* name;
};

constexpr WaveGroup WaveGroups[] = {{"GR", "地上波"}, {"BS", "BS"}, {"CS", "CS"}};

std::string Wave(const Json& station)
{
  const auto channel = station.find("channel");
  return channel != station.end() && channel->is_object() ? channel->value("type", "") : "";
}

unsigned int StableId(const std::string& text)
{
  uint32_t hash = 2166136261u;
  for (unsigned char character : text)
    hash = (hash ^ character) * 16777619u;
  return (hash % 2147483646u) + 1;
}

std::string Base64(const std::string& text)
{
  const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  for (size_t i = 0; i < text.size(); i += 3)
  {
    const size_t remaining = text.size() - i;
    uint32_t bits = static_cast<unsigned char>(text[i]) << 16;
    if (remaining > 1)
      bits |= static_cast<unsigned char>(text[i + 1]) << 8;
    if (remaining > 2)
      bits |= static_cast<unsigned char>(text[i + 2]);
    result += alphabet[(bits >> 18) & 63];
    result += alphabet[(bits >> 12) & 63];
    result += remaining > 1 ? alphabet[(bits >> 6) & 63] : '=';
    result += remaining > 2 ? alphabet[bits & 63] : '=';
  }
  std::string escaped;
  for (char ch : result)
    escaped += ch == '+' ? "%2B" : ch == '/' ? "%2F" : ch == '=' ? "%3D" : std::string(1, ch);
  return escaped;
}

bool Pending(const Json& row)
{
  return row.at("status") == "scheduled" || row.at("status") == "recording";
}

bool Playable(const Json& row)
{
  return !Pending(row) && (row.value("ts", false) || row.value("mp4", false));
}
}

class KreuzenPvr : public CInstancePVRClient
{
public:
  using CInstancePVRClient::CInstancePVRClient;

  PVR_ERROR GetBackendName(std::string& name) override { name = "uzume-tv"; return PVR_ERROR_NO_ERROR; }
  PVR_ERROR GetBackendVersion(std::string& version) override { version = "0.2.1"; return PVR_ERROR_NO_ERROR; }
  PVR_ERROR GetCapabilities(PVRCapabilities& caps) override
  {
    caps.SetSupportsTV(true);
    caps.SetSupportsChannelGroups(true);
    caps.SetSupportsEPG(true);
    caps.SetSupportsRecordings(true);
    caps.SetSupportsTimers(true);
    return PVR_ERROR_NO_ERROR;
  }

  PVR_ERROR GetChannelsAmount(int& amount) override
  {
    return Safe([&] { amount = static_cast<int>(Stations().size()); });
  }

  PVR_ERROR GetChannels(bool radio, PVRChannelsResultSet& results) override
  {
    if (radio)
      return PVR_ERROR_NO_ERROR;
    return Safe([&] {
      unsigned int number = 0;
      for (const auto& station : Stations())
      {
        const auto id = station.at("id").get<int64_t>();
        PVRChannel channel;
        channel.SetUniqueId(ChannelId(id));
        channel.SetChannelNumber(++number);
        channel.SetChannelName(station.at("name").get<std::string>());
        channel.SetIconPath(Server() + "/api/logos/" + std::to_string(id));
        results.Add(channel);
      }
    });
  }

  PVR_ERROR GetChannelGroupsAmount(int& amount) override
  {
    return Safe([&] { amount = static_cast<int>(AvailableWaves(Stations()).size()); });
  }

  PVR_ERROR GetChannelGroups(bool radio, PVRChannelGroupsResultSet& results) override
  {
    if (radio)
      return PVR_ERROR_NO_ERROR;
    return Safe([&] {
      unsigned int position = 0;
      for (const auto& wave : AvailableWaves(Stations()))
      {
        PVRChannelGroup group;
        group.SetGroupName(wave.name);
        group.SetPosition(++position);
        results.Add(group);
      }
    });
  }

  PVR_ERROR GetChannelGroupMembers(const PVRChannelGroup& group,
                                   PVRChannelGroupMembersResultSet& results) override
  {
    const auto name = group.GetGroupName();
    const auto wave = std::find_if(std::begin(WaveGroups), std::end(WaveGroups),
                                   [&](const WaveGroup& entry) { return name == entry.name; });
    if (group.GetIsRadio() || wave == std::end(WaveGroups))
      return PVR_ERROR_NO_ERROR;
    return Safe([&] {
      unsigned int number = 0;
      for (const auto& station : Stations())
      {
        ++number;
        if (Wave(station) != wave->type)
          continue;
        PVRChannelGroupMember member;
        member.SetGroupName(name);
        member.SetChannelUniqueId(ChannelId(station.at("id").get<int64_t>()));
        member.SetChannelNumber(number);
        results.Add(member);
      }
    });
  }

  PVR_ERROR GetChannelStreamProperties(const PVRChannel& channel,
                                       std::vector<PVRStreamProperty>& properties) override
  {
    return Safe([&] {
      for (const auto& station : Stations())
      {
        const auto id = station.at("id").get<int64_t>();
        if (ChannelId(id) != channel.GetUniqueId())
          continue;
        properties.emplace_back(PVR_STREAM_PROPERTY_STREAMURL, Server() + "/api/live/" + std::to_string(id));
        properties.emplace_back(PVR_STREAM_PROPERTY_ISREALTIMESTREAM, "true");
        return;
      }
      throw std::runtime_error("Channel unavailable");
    });
  }

  PVR_ERROR GetEPGForChannel(int channel, time_t start, time_t end, PVREPGTagsResultSet& results) override
  {
    return Safe([&] {
      const auto guide = Request("guide?from=" + std::to_string(int64_t(start) * 1000) +
                                 "&to=" + std::to_string(int64_t(end) * 1000));
      for (const auto& program : guide.at("programs"))
      {
        if (ChannelId(program.at("service").get<int64_t>()) != static_cast<unsigned>(channel))
          continue;
        const auto id = program.at("id").get<int64_t>();
        PVREPGTag tag;
        tag.SetUniqueBroadcastId(ProgramId(id));
        tag.SetUniqueChannelId(channel);
        tag.SetStartTime(program.at("start").get<int64_t>() / 1000);
        tag.SetEndTime(program.at("end").get<int64_t>() / 1000);
        tag.SetTitle(program.at("title").get<std::string>());
        tag.SetPlot(program.value("description", ""));
        results.Add(tag);
      }
    });
  }

  PVR_ERROR GetRecordingsAmount(bool deleted, int& amount) override
  {
    return Safe([&] {
      amount = 0;
      if (!deleted)
        for (const auto& row : Rows())
          amount += Playable(row);
    });
  }

  PVR_ERROR GetRecordings(bool deleted, PVRRecordingsResultSet& results) override
  {
    if (deleted)
      return PVR_ERROR_NO_ERROR;
    return Safe([&] {
      for (const auto& row : Rows())
      {
        if (!Playable(row))
          continue;
        PVRRecording recording;
        const auto id = row.at("id").get<std::string>();
        recording.SetRecordingId(id);
        recording.SetTitle(row.at("title").get<std::string>());
        recording.SetPlot(row.value("description", ""));
        recording.SetRecordingTime(row.at("start").get<int64_t>() / 1000);
        recording.SetDuration(std::max<int64_t>(0, (row.at("end").get<int64_t>() - row.at("start").get<int64_t>()) / 1000));
        recording.SetChannelUid(ChannelId(row.at("service").get<int64_t>()));
        recording.SetChannelType(PVR_RECORDING_CHANNEL_TYPE_TV);
        recording.SetThumbnailPath(Server() + "/api/reservations/" + id + "/thumbnail");
        const auto options = row.value("options", Json::object());
        if (options.is_object())
        {
          const auto folder = options.value("subDirectory", "");
          if (!folder.empty())
            recording.SetDirectory(folder);
        }
        results.Add(recording);
      }
    });
  }

  PVR_ERROR GetRecordingStreamProperties(const PVRRecording& recording,
                                         std::vector<PVRStreamProperty>& properties) override
  {
    return Safe([&] {
      for (const auto& row : Rows())
      {
        if (row.at("id") != recording.GetRecordingId() || !Playable(row))
          continue;
        const auto format = row.value("mp4", false) ? "/mp4" : "/ts";
        properties.emplace_back(PVR_STREAM_PROPERTY_STREAMURL, Server() + "/api/reservations/" +
                               recording.GetRecordingId() + format);
        return;
      }
      throw std::runtime_error("Recording unavailable");
    });
  }

  PVR_ERROR GetTimerTypes(std::vector<PVRTimerType>& types) override
  {
    PVRTimerType type;
    type.SetId(1);
    type.SetDescription("uzume-tv: record programme");
    type.SetAttributes(PVR_TIMER_TYPE_REQUIRES_EPG_TAG_ON_CREATE | PVR_TIMER_TYPE_SUPPORTS_CHANNELS |
                       PVR_TIMER_TYPE_SUPPORTS_START_TIME | PVR_TIMER_TYPE_SUPPORTS_END_TIME);
    types.push_back(type);
    return PVR_ERROR_NO_ERROR;
  }

  PVR_ERROR GetTimersAmount(int& amount) override
  {
    return Safe([&] {
      amount = 0;
      for (const auto& row : Rows())
        amount += Pending(row);
    });
  }

  PVR_ERROR GetTimers(PVRTimersResultSet& results) override
  {
    return Safe([&] {
      for (const auto& row : Rows())
      {
        if (!Pending(row))
          continue;
        PVRTimer timer;
        timer.SetClientIndex(StableId(row.at("id").get<std::string>()));
        timer.SetClientChannelUid(ChannelId(row.at("service").get<int64_t>()));
        timer.SetTimerType(1);
        timer.SetTitle(row.at("title").get<std::string>());
        timer.SetStartTime(row.at("start").get<int64_t>() / 1000);
        timer.SetEndTime(row.at("end").get<int64_t>() / 1000);
        timer.SetEPGUid(ProgramId(row.at("programId").get<int64_t>()));
        timer.SetState(row.at("status") == "recording" ? PVR_TIMER_STATE_RECORDING :
                       row.value("conflict", false) ? PVR_TIMER_STATE_CONFLICT_NOK : PVR_TIMER_STATE_SCHEDULED);
        results.Add(timer);
      }
    });
  }

  PVR_ERROR AddTimer(const PVRTimer& timer) override
  {
    return Safe([&] {
      const int64_t start = int64_t(timer.GetStartTime()) * 1000;
      const auto guide = Request("guide?from=" + std::to_string(start - 86400000) +
                                 "&to=" + std::to_string(start + 86400000));
      for (const auto& program : guide.at("programs"))
      {
        const auto id = program.at("id").get<int64_t>();
        if (ProgramId(id) == timer.GetEPGUid() &&
            ChannelId(program.at("service").get<int64_t>()) == static_cast<unsigned>(timer.GetClientChannelUid()))
        {
          Request("reservations", Json{{"programId", id}}.dump());
          TriggerTimerUpdate();
          return;
        }
      }
      throw std::runtime_error("EPG programme unavailable");
    });
  }

  PVR_ERROR DeleteTimer(const PVRTimer& timer, bool) override
  {
    return Safe([&] {
      for (const auto& row : Rows())
      {
        const auto id = row.at("id").get<std::string>();
        if (Pending(row) && StableId(id) == timer.GetClientIndex())
        {
          Request("reservations/" + id + "/cancel", "{}");
          TriggerTimerUpdate();
          return;
        }
      }
      throw std::runtime_error("Timer unavailable");
    });
  }

private:
  template<class Operation>
  PVR_ERROR Safe(Operation operation)
  {
    try
    {
      operation();
      return PVR_ERROR_NO_ERROR;
    }
    catch (const std::exception& error)
    {
      kodi::Log(ADDON_LOG_ERROR, "uzume-tv: %s", error.what());
      return PVR_ERROR_SERVER_ERROR;
    }
  }

  static std::string Server()
  {
    std::string base = kodi::addon::GetSettingString("server");
    while (!base.empty() && base.back() == '/')
      base.pop_back();
    if (base.find('|') != std::string::npos ||
        (base.rfind("http://", 0) != 0 && base.rfind("https://", 0) != 0))
      throw std::runtime_error("Set the uzume-tv server URL");
    return base;
  }

  static Json Request(const std::string& endpoint, const std::string& body = "")
  {
    kodi::vfs::CFile file;
    std::string url = Server() + "/api/" + endpoint + "|connection-timeout=5";
    if (!body.empty())
      url += "&customrequest=POST&Content-Type=application%2Fjson&postdata=" + Base64(body);
    if (!file.OpenFile(url, ADDON_READ_NO_CACHE))
      throw std::runtime_error("uzume-tv request failed: " + endpoint);
    std::string bytes;
    char buffer[8192];
    while (true)
    {
      const auto length = file.Read(buffer, sizeof(buffer));
      if (length < 0)
        throw std::runtime_error("uzume-tv response interrupted");
      if (!length)
        break;
      bytes.append(buffer, length);
      if (bytes.size() > 32 * 1024 * 1024)
        throw std::runtime_error("uzume-tv response too large");
    }
    auto result = Json::parse(bytes);
    if (result.contains("error"))
      throw std::runtime_error(result.at("error").get<std::string>());
    return result;
  }

  static std::vector<WaveGroup> AvailableWaves(const Json& stations)
  {
    std::set<std::string> types;
    for (const auto& station : stations)
      types.insert(Wave(station));
    std::vector<WaveGroup> groups;
    for (const auto& wave : WaveGroups)
      if (types.count(wave.type))
        groups.push_back(wave);
    return groups;
  }

  static Json Rows() { return Request("state").at("reservations"); }
  static Json Stations()
  {
    auto guide = Request("guide?from=1&to=2");
    const auto hidden = guide.at("guideHiddenChannels").get<std::set<int64_t>>();
    auto stations = Json::array();
    for (const auto& station : guide.at("services"))
      if (!hidden.count(station.at("id").get<int64_t>()))
        stations.push_back(station);
    return stations;
  }
  static unsigned ChannelId(int64_t id) { return StableId("channel:" + std::to_string(id)); }
  static unsigned ProgramId(int64_t id) { return StableId("programme:" + std::to_string(id)); }
};

class KreuzenAddon : public CAddonBase
{
  ADDON_STATUS CreateInstance(const IInstanceInfo& info, KODI_ADDON_INSTANCE_HDL& handle) override
  {
    if (!info.IsType(ADDON_INSTANCE_PVR))
      return ADDON_STATUS_NOT_IMPLEMENTED;
    handle = new KreuzenPvr(info);
    return ADDON_STATUS_OK;
  }
};

ADDONCREATOR(KreuzenAddon)

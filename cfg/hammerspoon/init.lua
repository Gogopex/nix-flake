local apps = {
  { key = "1", app = "Ghostty" },
  { key = "2", app = "Arc" },
  { key = "3", app = "Obsidian" },
  { key = "4", app = "Sublime Text" },
  { key = "5", app = "ChatGPT" },
}

for _, binding in ipairs(apps) do
  hs.hotkey.bind({"shift", "ctrl", "alt", "cmd"}, binding.key, function()
    hs.application.launchOrFocus(binding.app)
  end)
end

local fastWorkspaceSwitch = "/run/current-system/sw/bin/fast-workspace-switch"

local function switchWorkspace(direction, count)
  if hs.fs.attributes(fastWorkspaceSwitch) == nil then
    hs.alert.show("fast-workspace-switch is not installed")
    return
  end

  hs.task.new(fastWorkspaceSwitch, nil, {direction, tostring(count or 1)}):start()
end

hs.hotkey.bind({"cmd", "alt"}, "h", function()
  switchWorkspace("left", 1)
end)

hs.hotkey.bind({"cmd", "alt"}, "l", function()
  switchWorkspace("right", 1)
end)

local logConfig = {
  enabled = true,
  onlyWithModifiers = true,
  flushEvery = 50,
  flushIntervalSec = 5,
  logPath = os.getenv("HOME") .. "/.local/share/hammerspoon/keylog.jsonl",
}

local function ensureDir(path)
  if hs.fs.attributes(path) ~= nil then
    return
  end
  hs.fs.mkdir(path)
end

local function ensureLogDir()
  local base = os.getenv("HOME") .. "/.local"
  local share = base .. "/share"
  local hsDir = share .. "/hammerspoon"
  ensureDir(base)
  ensureDir(share)
  ensureDir(hsDir)
end

ensureLogDir()

local logBuffer = {}
local flushLog = function() end

local function jsonEscape(value)
  local escaped = value:gsub("\\", "\\\\")
  escaped = escaped:gsub("\"", "\\\"")
  return escaped
end

flushLog = function()
  if #logBuffer == 0 then
    return
  end
  local file = io.open(logConfig.logPath, "a")
  if not file then
    return
  end
  file:write(table.concat(logBuffer))
  file:close()
  logBuffer = {}
end

local function comboName(event)
  local flags = event:getFlags()
  local mods = {}
  if flags.ctrl then table.insert(mods, "ctrl") end
  if flags.alt then table.insert(mods, "alt") end
  if flags.shift then table.insert(mods, "shift") end
  if flags.cmd then table.insert(mods, "cmd") end
  if flags.fn then table.insert(mods, "fn") end

  if logConfig.onlyWithModifiers and #mods == 0 then
    return nil
  end

  local key = hs.keycodes.map[event:getKeyCode()] or tostring(event:getKeyCode())
  if #mods > 0 then
    return table.concat(mods, "+") .. "+" .. key
  end
  return key
end

local keylogTap = nil
if logConfig.enabled then
  keylogTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown }, function(event)
    local combo = comboName(event)
    if not combo then
      return false
    end
    local ts = math.floor(hs.timer.secondsSinceEpoch())
    local escaped = jsonEscape(combo)
    logBuffer[#logBuffer + 1] = string.format("{\"ts\":%d,\"combo\":\"%s\"}\n", ts, escaped)
    if #logBuffer >= logConfig.flushEvery then
      flushLog()
    end
    return false
  end)
  keylogTap:start()
  hs.timer.doEvery(logConfig.flushIntervalSec, flushLog)
end

function reloadConfig(files)
  local doReload = false
  for _, file in pairs(files) do
    if file:sub(-4) == ".lua" then
      doReload = true
      break
    end
  end
  if doReload then
    flushLog()
    hs.reload()
  end
end

myWatcher = hs.pathwatcher.new(os.getenv("HOME") .. "/.hammerspoon/", reloadConfig):start()
hs.alert.show("hammerspoon config loaded")

hs.shutdownCallback = function()
  flushLog()
end

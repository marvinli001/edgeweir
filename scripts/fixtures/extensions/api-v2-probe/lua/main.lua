local M = {}

function M.endpoint(ew)
  local function fingerprint(secret)
    if not secret then return "" end
    return (ew.sha256(secret):gsub(".", function(byte)
      return string.format("%02x", byte:byte())
    end))
  end
  local secrets = ew.secrets()
  return ew.respond(200, fingerprint(secrets.current) .. ":" .. fingerprint(secrets.previous), {
    ["Content-Type"] = "text/plain",
  })
end

return M

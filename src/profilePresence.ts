type ProfilePresenceInput = {
  loaded: boolean;
  userStatus: "online" | "away" | "busy" | "offline";
  connection: string;
};

/** The selected status is a preference; a live transport is required to show it. */
export function profilePresence(profile: ProfilePresenceInput): ProfilePresenceInput["userStatus"] | "connecting" {
  if (!profile.loaded || profile.userStatus === "offline" || profile.connection === "locked") return "offline";
  return profile.connection === "tcp" || profile.connection === "udp" ? profile.userStatus : "connecting";
}

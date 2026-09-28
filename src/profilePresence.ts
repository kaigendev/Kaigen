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

/** A previous friend snapshot cannot prove presence after our transport disconnects. */
export function contactPresence(
  contact: { connection: string; status: ProfilePresenceInput["userStatus"] },
  ownStatus: ProfilePresenceInput["userStatus"],
  networkStatus: string,
): ProfilePresenceInput["userStatus"] {
  if (ownStatus === "offline" || networkStatus !== "online" || contact.connection !== "online") return "offline";
  return contact.status;
}

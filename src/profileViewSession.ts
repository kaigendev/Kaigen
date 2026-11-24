import { useEffect, useRef } from "react";
import { invoke } from "@kaigen/platform";
import { isWebgateProfileId } from "./webgate/platformRouter";
import { watchProfileUpdates } from "./webgate/realtime";
import type { CoreFriend, LocalState } from "./App";
import type { ContactGroupsState } from "./contactGroups";

const emptyFriends: CoreFriend[] = [];

/** A loaded profile outlives any individual messenger view. */
export class ProfileViewSession {
  live = true;
  contactRevision = 0;
  pendingContactEdits = 0;
  readonly localSaveQueue = { current: Promise.resolve() };
  switchSave: { state: LocalState; failed: boolean } | null = null;
  confirmedContactGroups: ContactGroupsState | null = null;
  confirmedSpellcheck: Required<Pick<LocalState, "spellcheckEnabled" | "spellcheckRussian" | "spellcheckEnglish">> | null = null;
  preferenceSaveFailed = false;
  private friends = emptyFriends;
  private readonly listeners = new Set<() => void>();

  readFriends = () => this.friends;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  publishFriends(friends: CoreFriend[]) {
    if (!this.live || JSON.stringify(this.friends) === JSON.stringify(friends)) return;
    this.friends = friends;
    for (const listener of this.listeners) listener();
  }

  close() {
    this.live = false;
    this.friends = emptyFriends;
    this.switchSave = null;
    this.confirmedContactGroups = null;
    this.confirmedSpellcheck = null;
    this.preferenceSaveFailed = false;
  }
}

const contactChangeCommands = new Set([
  "add_tox_friend", "delete_tox_friend",
  "accept_incoming_friend_request", "reject_incoming_friend_request",
  "send_tox_message", "cancel_tox_message", "delete_tox_message", "clear_tox_history",
  "control_tox_file_transfer", "complete_web_incoming_transfer",
]);

function changesContacts(payload: unknown): boolean {
  type Change = { kind?: string; command?: string; resyncRequired?: boolean };
  const event = payload as (Change & { event?: string; payload?: Change & { change?: Change } }) | undefined;
  const change = event?.payload?.change ?? event?.payload ?? event;
  if (change?.resyncRequired || event?.event === "resync-required" || event?.event === "connection-ready") return true;
  // Selection events only change which loaded profile owns the view.
  if (change?.kind === "profiles") return false;
  return change?.kind !== "command" || contactChangeCommands.has(change.command ?? "");
}

export function ProfileContactFeed({ profileId, active, session }: { profileId: string; active: boolean; session: ProfileViewSession }) {
  const pollLocalProfile = useRef(active);
  useEffect(() => { pollLocalProfile.current = active; }, [active]);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const revision = session.contactRevision;
      const friends = await invoke<CoreFriend[]>("get_tox_friends", { profileId });
      if (!disposed && revision === session.contactRevision) session.publishFriends(friends);
    };
    const stop = watchProfileUpdates(profileId, refresh, 5000, undefined,
      isWebgateProfileId(profileId) ? changesContacts : undefined, () => pollLocalProfile.current);
    return () => { disposed = true; stop(); };
  }, [profileId, session]);

  return null;
}

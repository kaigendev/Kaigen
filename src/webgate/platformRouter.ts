export type RawInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type RemoteSummary = { id: string; profileId?: string; metadata?: { profileId?: string }; active?: boolean; loaded?: boolean; backend?: string };
export type ProfilesView = { profiles: RemoteSummary[]; activeProfileId?: string | null; initialConnectionPresetRequired?: boolean; webgateStoreError?: string | null };
export type WebgateRouterOptions = {
  onProfiles?: (view: ProfilesView) => void;
  onProfileReplaced?: (profileId: string) => void;
  localInvoke?: (command: string, args: Record<string, unknown>, profileId: string) => Promise<unknown> | undefined;
};

export const isWebgateProfileId = (id: unknown): boolean => typeof id === "string" && id.startsWith("wg-");

const ACCOUNT_COMMANDS = /^(?:get_tox_|set_tox_|send_tox_|control_tox_|retry_tox_|cancel_tox_|refresh_chat_|close_chat_|get_pq_|request_pq_|cancel_pq_|set_pq_|get_chat_|get_incoming_friend_|accept_incoming_friend_|reject_incoming_friend_|remove_tox_|add_tox_)/u;
const ACCOUNT_EXTRAS = new Set([
  "get_unread_state", "mark_friend_read", "mark_requests_read", "acknowledge_local_messages",
  "set_profile_user_status", "get_file_receive_settings", "set_file_receive_settings",
  "load_local_state", "save_local_state", "load_layout_state", "save_layout_state",
  "delete_chat_message", "delete_chat_messages", "clear_chat_history", "search_chat_messages",
  "export_tox_history", "download_web_transfer", "open_web_video",
  "delete_tox_message", "delete_tox_friend", "search_tox_messages", "clear_tox_history",
  "set_message_reactions", "release_chat_history", "set_chat_history_enabled", "set_profile_avatar",
  "begin_pq_entropy", "complete_pq_identity", "skip_pq_auto", "withdraw_pq_session",
  "accept_pq_session", "reject_pq_session", "get_background_transfer_work",
]);

/** Routes remote account work through native IPC or the browser's own webd. */
export function createWebgatePlatformRouter(rawInvoke: RawInvoke, options: WebgateRouterOptions = {}): RawInvoke {
  let activeRemote: string | null = null;
  const loaded = new Set<string>();
  const accept = (view: ProfilesView) => {
    loaded.clear();
    for (const profile of view.profiles) if (profile.loaded) loaded.add(profile.id);
    activeRemote = view.profiles.find((profile) => isWebgateProfileId(profile.id) && profile.active)?.id ?? null;
    options.onProfiles?.(view);
    return view;
  };
  const profiles = async () => accept(await rawInvoke<ProfilesView>("webgate_profiles"));
  return async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (command === "connect_webgate_profile" || command === "update_webgate_profile") {
      const view = await rawInvoke<ProfilesView>(command, args);
      if (command === "update_webgate_profile" && typeof args.profileId === "string") options.onProfileReplaced?.(args.profileId);
      return accept(view) as T;
    }
    if (["webgate_profiles", "webgate_select_profile", "webgate_disconnect_profile", "webgate_restore_profile", "webgate_forget_profile"].includes(command)) {
      return accept(await rawInvoke<ProfilesView>(command, args)) as T;
    }
    if (command === "get_webgate_connection_card" || command === "save_webgate_connection_card") {
      return rawInvoke<T>(command, args);
    }
    if (command === "get_startup_state") {
      const startup = await rawInvoke<Record<string, unknown>>(command, args);
      const view = await profiles();
      return { ...startup, profiles: view.profiles, firstRun: view.profiles.length === 0, webgateStoreError: view.webgateStoreError,
        ...(activeRemote ? { initialConnectionPresetRequired: false } : {}) } as T;
    }
    if (command === "unlock_profile" && isWebgateProfileId(args.profileId)) {
      return accept(await rawInvoke<ProfilesView>("webgate_restore_profile", { profileId: args.profileId })).profiles as T;
    }
    if (command === "create_profile" || command === "import_qtox_profile" || command === "unlock_profile") {
      const result = await rawInvoke<unknown>(command, args);
      const view = accept(await rawInvoke<ProfilesView>("webgate_select_profile", { profileId: null }));
      return (Array.isArray(result) ? view.profiles : { ...(result as Record<string, unknown>), profiles: view.profiles }) as T;
    }
    if (command === "switch_profile") {
      if (isWebgateProfileId(args.profileId)) {
        const operation = loaded.has(String(args.profileId)) ? "webgate_select_profile" : "webgate_restore_profile";
        return accept(await rawInvoke<ProfilesView>(operation, { profileId: args.profileId })).profiles as T;
      }
      await rawInvoke(command, args);
      return accept(await rawInvoke<ProfilesView>("webgate_select_profile", { profileId: null })).profiles as T;
    }
    if (command === "continue_with_loaded_profiles") {
      if (!activeRemote || !loaded.has(activeRemote)) await rawInvoke(command, args);
      const view = await profiles();
      if (view.profiles.some((profile) => profile.active && profile.loaded)) return view.profiles as T;
      const next = view.profiles.find((profile) => profile.loaded && isWebgateProfileId(profile.id));
      if (!next) return view.profiles as T;
      return accept(await rawInvoke<ProfilesView>("webgate_select_profile", { profileId: next.id })).profiles as T;
    }
    if ((command === "disable_profile" || command === "lock_profile") && isWebgateProfileId(args.profileId)) {
      return accept(await rawInvoke<ProfilesView>(command === "lock_profile" ? "webgate_disconnect_profile" : "webgate_forget_profile", { profileId: args.profileId })).profiles as T;
    }
    if (command === "destroy_active_profile" && (isWebgateProfileId(args.profileId) || activeRemote)) {
      return accept(await rawInvoke<ProfilesView>("webgate_forget_profile", { profileId: args.profileId ?? activeRemote })).profiles as T;
    }
    const explicit = args.profileId;
    const profileId = isWebgateProfileId(explicit) ? explicit
      : explicit == null && activeRemote && (ACCOUNT_COMMANDS.test(command) || ACCOUNT_EXTRAS.has(command)) ? activeRemote : null;
    if (profileId && !command.startsWith("webgate_") && command !== "get_webgate_connection_card") {
      const local = options.localInvoke?.(command, args, String(profileId));
      if (local !== undefined) return await local as T;
      return rawInvoke<T>("webgate_invoke", { profileId, command, args,
        operationId: typeof args.operationId === "string" ? args.operationId : crypto.randomUUID() });
    }
    if (command === "disable_profile" || command === "destroy_active_profile") {
      await rawInvoke(command, args);
      return (await profiles()).profiles as T;
    }
    return rawInvoke<T>(command, args);
  };
}

/** The native and browser emitters expose the same local-alias event envelope. */
export function webgateTransferWake(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { profileId?: unknown; event?: { event?: string; payload?: Record<string, unknown> } };
  if (!isWebgateProfileId(envelope.profileId) || !envelope.event) return null;
  const event = envelope.event;
  const change = event.payload;
  if (event.event === "connection-ready" || event.event === "resync-required" || change?.kind === "transfer"
    || change?.transfer || change?.resyncRequired === true
    || (change?.kind === "command" && ["control_tox_file_transfer", "complete_web_incoming_transfer"].includes(String(change.command)))) {
    return String(envelope.profileId);
  }
  return null;
}

export type WebgateHistoryWriter = {
  write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
  finish: () => Promise<void>;
  abort: () => Promise<void>;
};

/** User-requested history is paged into an explicit output, never a cache file. */
export async function exportWebgateHistory(profileId: string, args: Record<string, unknown>, invoke: RawInvoke,
  open: (name: string) => Promise<WebgateHistoryWriter>) {
  const friendNumber = Number(args.friendNumber);
  if (!Number.isSafeInteger(friendNumber) || friendNumber < 0) throw new Error("COMMAND_ARGUMENT_INVALID");
  const contact = String(args.contactName || args.contactId || "contact");
  const language = document.documentElement.lang === "en" ? "en" : "ru";
  const formatter = new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  type Message = { text?: string; timestamp?: number; mine?: boolean; attachment?: { name?: string } | null };
  type Page = { messages: Message[]; nextOffset: number; done: boolean };
  const name = `${contact.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").slice(0, 96) || "contact"}-${new Date().toISOString().slice(0, 10)}.txt`;
  const writer = await open(name);
  try {
    let offset = 0;
    let wroteMessages = false;
    const encoder = new TextEncoder();
    while (true) {
      const page = await invoke<Page>("get_tox_messages_page", { profileId, friendNumber, offset, limit: 256 });
      if (!page || !Array.isArray(page.messages)) throw new Error("HISTORY_EXPORT_CURSOR_INVALID");
      for (const message of page.messages) {
        const timestamp = Number(message.timestamp ?? 0) * 1000;
        if (!Number.isFinite(timestamp)) throw new Error("HISTORY_EXPORT_MESSAGE_INVALID");
        const author = message.mine ? (language === "ru" ? "Я" : "Me") : contact;
        const text = message.attachment?.name ? `${language === "ru" ? "Вложение" : "Attachment"}: ${message.attachment.name}` : String(message.text ?? "");
        const bytes = encoder.encode(`${wroteMessages ? "\r\n\r\n" : ""}${formatter.format(new Date(timestamp))}\r\n${author}: ${text}`);
        for (let position = 0; position < bytes.byteLength; position += 256 * 1024) await writer.write(bytes.slice(position, position + 256 * 1024));
        wroteMessages = true;
      }
      if (page.done) break;
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("HISTORY_EXPORT_CURSOR_INVALID");
      offset = page.nextOffset;
    }
    await writer.finish();
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
  return name;
}

import { invoke } from "@kaigen/platform";

const requests = new Map<string, Promise<number | null>>();

export const pendingHistoryClear = (profileId: string) => requests.get(profileId);

export function clearProfileHistory(profileId: string): Promise<number | null> {
  const pending = requests.get(profileId);
  if (pending) return pending;
  const request = invoke<number | null>("clear_tox_history", { profileId, friendNumber: null }).then((historyClearEpoch) => {
    window.dispatchEvent(new CustomEvent("kaigen:chat-history-cleared", { detail: { profileId, historyClearEpoch } }));
    return historyClearEpoch;
  });
  requests.set(profileId, request);
  void request.finally(() => { if (requests.get(profileId) === request) requests.delete(profileId); }).catch(() => {});
  return request;
}

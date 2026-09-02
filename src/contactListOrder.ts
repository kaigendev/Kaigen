export type ContactListStatus = "online" | "away" | "busy" | "offline";
export type ContactSortMode = "activity" | "status";
export type ContactSortDirection = "forward" | "reverse";

export type ContactSortState = {
  mode: ContactSortMode;
  direction: ContactSortDirection;
};

export type ContactListOrder = ContactSortState & {
  hideOffline: boolean;
};

export const DEFAULT_CONTACT_SORT: ContactSortState = {
  mode: "activity",
  direction: "forward",
};

type SortableContact = {
  status: ContactListStatus;
  lastEvent?: number | null;
};

const STATUS_ORDER: Record<ContactListStatus, number> = {
  online: 0,
  away: 1,
  busy: 2,
  offline: 3,
};

function eventTime(contact: SortableContact): number {
  return contact.lastEvent ?? 0;
}

export function normalizeContactSort(value: unknown): ContactSortState {
  if (!value || typeof value !== "object") return DEFAULT_CONTACT_SORT;
  const candidate = value as Partial<ContactSortState>;
  const mode = candidate.mode === "status" ? "status" : "activity";
  const direction = candidate.direction === "reverse" ? "reverse" : "forward";
  return { mode, direction };
}

export function toggleContactSort(current: ContactSortState, mode: ContactSortMode): ContactSortState {
  if (current.mode !== mode) return { mode, direction: "forward" };
  return { mode, direction: current.direction === "forward" ? "reverse" : "forward" };
}

export function orderContacts<T extends SortableContact>(contacts: readonly T[], order: ContactListOrder): T[] {
  return contacts
    .map((contact, index) => ({ contact, index }))
    .filter(({ contact }) => !order.hideOffline || contact.status !== "offline")
    .sort((left, right) => {
      if (order.mode === "status") {
        const direction = order.direction === "forward" ? 1 : -1;
        const statusDifference = (STATUS_ORDER[left.contact.status] - STATUS_ORDER[right.contact.status]) * direction;
        if (statusDifference !== 0) return statusDifference;
        const eventDifference = eventTime(right.contact) - eventTime(left.contact);
        return eventDifference || left.index - right.index;
      }

      const direction = order.direction === "forward" ? 1 : -1;
      const eventDifference = (eventTime(right.contact) - eventTime(left.contact)) * direction;
      return eventDifference || left.index - right.index;
    })
    .map(({ contact }) => contact);
}

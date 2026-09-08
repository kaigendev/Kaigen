export type ContactListStatus = "online" | "away" | "busy" | "offline";
export type ContactSortMode = "activity" | "status";
export type ContactSortDirection = "forward" | "reverse";

export type ContactSortState = {
  mode: ContactSortMode;
  direction: ContactSortDirection;
};

export type ContactListOrder = ContactSortState & {
  hideOffline: boolean;
  heldContactId?: string | null;
};

export const DEFAULT_CONTACT_SORT: ContactSortState = {
  mode: "activity",
  direction: "forward",
};

type SortableContact = {
  id?: string;
  status: ContactListStatus;
  lastEvent?: number | null;
  eventSequence?: number | null;
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
      if (order.mode === "activity" && order.direction === "forward" && order.heldContactId) {
        const heldDifference = Number(right.contact.id === order.heldContactId) - Number(left.contact.id === order.heldContactId);
        if (heldDifference) return heldDifference;
      }
      if (order.mode === "status") {
        const direction = order.direction === "forward" ? 1 : -1;
        const statusDifference = (STATUS_ORDER[left.contact.status] - STATUS_ORDER[right.contact.status]) * direction;
        if (statusDifference !== 0) return statusDifference;
        const eventDifference = eventTime(right.contact) - eventTime(left.contact);
        return eventDifference || (right.contact.eventSequence ?? 0) - (left.contact.eventSequence ?? 0) || left.index - right.index;
      }

      const direction = order.direction === "forward" ? 1 : -1;
      const eventDifference = (eventTime(right.contact) - eventTime(left.contact)) * direction;
      return eventDifference || ((right.contact.eventSequence ?? 0) - (left.contact.eventSequence ?? 0)) * direction || left.index - right.index;
    })
    .map(({ contact }) => contact);
}

export type ActivityHold = {
  contactId: string | null;
  selectedId: string;
  events: Record<string, number>;
};

export function updateActivityHold(
  previous: ActivityHold,
  contacts: readonly (SortableContact & { id: string })[],
  selectedId: string,
  sort: ContactSortState,
  promotedId?: string,
): ActivityHold {
  const events = Object.fromEntries(contacts.map((contact) => [contact.id, contact.eventSequence ?? eventTime(contact)]));
  let contactId = previous.contactId;
  if (sort.mode !== "activity" || sort.direction !== "forward") contactId = null;
  else {
    if (contactId && !(contactId in events)) contactId = null;
    // After deselection ordinary event order resumes. It remains first unless
    // another contact has actually gained a newer event, including while held.
    if (contactId && selectedId !== contactId) contactId = null;
    if (promotedId && promotedId === selectedId && promotedId in events) contactId = promotedId;
    const selectedChanged = selectedId in previous.events && events[selectedId] > previous.events[selectedId];
    const naturalFirst = orderContacts(contacts, { ...sort, hideOffline: false })[0]?.id;
    if (!contactId && selectedChanged && naturalFirst === selectedId) contactId = selectedId;
  }
  return { contactId, selectedId, events };
}
